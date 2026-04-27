import asyncio
import base64
import hashlib
import json
import os
import random
import re
import time
import traceback
import urllib.parse
import uuid
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

load_dotenv()

app = FastAPI()

# 정적 리소스 자동 캐시버스터: 서버 기동 시각을 version 토큰으로 삽입.
# 서버 재시작 = 브라우저가 새 리소스 로드. 수동 ?v=3 bump 불필요.
STATIC_VERSION = str(int(time.time()))
STATIC_DIR = Path(__file__).parent / "static"
INDEX_TEMPLATE = (STATIC_DIR / "index.html").read_text(encoding="utf-8")

# ─── LLM 백엔드 하이브리드 전환 ───────────────────────
LLM_MODE = os.getenv("LLM_MODE", "anthropic").lower()

if LLM_MODE == "wrapper":
    from openai import AsyncOpenAI
    llm_client = AsyncOpenAI(
        base_url=os.getenv("WRAPPER_URL", "http://localhost:8000/v1"),
        api_key=os.getenv("WRAPPER_API_KEY", "sk-dummy"),
    )
    LLM_MODEL = os.getenv("WRAPPER_MODEL", "claude-sonnet-4-6")
else:
    import anthropic
    llm_client = anthropic.AsyncAnthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
    LLM_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-6")

print(f"[LLM] mode={LLM_MODE}  model={LLM_MODEL}")

# LLM 호출에 타임아웃을 걸어 API 가 멍때리는 동안 방 전체가 블록되는 것을 방지.
LLM_TIMEOUT_SEC = float(os.getenv("LLM_TIMEOUT_SEC", "60"))


class LLMTimeoutError(Exception):
    """LLM 호출이 LLM_TIMEOUT_SEC 내에 응답을 못 준 경우."""


# 하이브리드 추론 모델(GLM-5.x, Qwen3 등)은 기본적으로 응답 전 "사고" 토큰을 생성 → 매 호출 30~60초+.
# 우리 게임은 짧은 턴 응답이 중요하니 사고 단계를 끈다. 추론이 필요한 모델로 바꿀 거면 이 값을 0 으로.
# 자세한 배경: docs/LLM_REASONING_NOTE.md
WRAPPER_DISABLE_THINKING = os.getenv("WRAPPER_DISABLE_THINKING", "1") == "1"

# 🆕 Failover 체인 — 1차 모델이 타임아웃/DEGRADED/4xx/5xx 시 순차적으로 시도할 모델 목록.
# .env 의 WRAPPER_FALLBACKS=model1,model2,... 형식. 빈 문자열이면 failover 없이 1차만.
_raw_fallbacks = os.getenv("WRAPPER_FALLBACKS", "").strip()
WRAPPER_FALLBACKS: List[str] = [m.strip() for m in _raw_fallbacks.split(",") if m.strip()]
if WRAPPER_FALLBACKS:
    print(f"[LLM] failover chain: {LLM_MODEL} → {' → '.join(WRAPPER_FALLBACKS)}")

# wrapper 첫 호출 후 한 번만 reasoning 상태 진단 로그 출력 (반복 스팸 방지).
_REASONING_PROBE_DONE = False


def _probe_reasoning(resp, elapsed_sec: float):
    """첫 wrapper 응답 한 번만 분석 — thinking 차단이 실제로 먹혔는지 콘솔에 보고."""
    global _REASONING_PROBE_DONE
    if _REASONING_PROBE_DONE:
        return
    _REASONING_PROBE_DONE = True
    try:
        msg = resp.choices[0].message
        content = getattr(msg, "content", "") or ""
        # 1) 별도 reasoning_content 필드 (DeepSeek/Qwen 스타일)
        rc = getattr(msg, "reasoning_content", None) or getattr(msg, "reasoning", None) or ""
        rc_len = len(rc) if isinstance(rc, str) else 0
        # 2) 본문에 <think> 또는 <thinking> 태그 섞였는지
        has_inline_think = ("<think>" in content) or ("<thinking>" in content)
        verdict = (
            "OFF (thinking 차단 성공)"
            if rc_len == 0 and not has_inline_think
            else f"ON (reasoning_len={rc_len}, inline_think={has_inline_think})"
        )
    except Exception as e:
        verdict = f"확인 실패: {type(e).__name__}: {e}"
    print(
        f"[REASONING PROBE] model={LLM_MODEL} disable_flag={WRAPPER_DISABLE_THINKING} "
        f"elapsed={elapsed_sec:.1f}s → {verdict}"
    )


def _is_failover_worthy(exc: BaseException) -> bool:
    """🆕 다음 모델로 fallback 시도해볼 만한 예외인가?
    - LLMTimeoutError (모델 응답 자체 못 받음)
    - 4xx (특히 400 DEGRADED, 404, 429)
    - 5xx (서버 장애)
    OpenAI SDK 의 APIStatusError 계열을 status_code 로 분류."""
    if isinstance(exc, LLMTimeoutError):
        return True
    code = getattr(exc, "status_code", None)
    if isinstance(code, int) and (400 <= code < 600):
        return True
    # 메시지에 DEGRADED 들어있으면 NIM 의 비활성 신호 — 명확한 fallback 신호
    if "DEGRADED" in str(exc):
        return True
    return False


async def _call_one_wrapper_model(model_id: str, system: str, messages: List[dict],
                                  max_tokens: int) -> Tuple[str, bool]:
    """🆕 wrapper 모드에서 특정 model_id 로 1회 호출. (text, truncated) 반환.
    실패 시 예외를 그대로 raise — 호출자가 failover 결정."""
    kwargs = dict(
        model=model_id,
        max_tokens=max_tokens,
        messages=[{"role": "system", "content": system}] + messages,
    )
    if WRAPPER_DISABLE_THINKING:
        # NVIDIA NIM 의 하이브리드 추론 모델용 — chat_template_kwargs 로 thinking 단계 차단.
        # 모델이 이 키를 인식 못하면 그냥 무시되므로 비-추론 모델에도 안전.
        kwargs["extra_body"] = {
            "chat_template_kwargs": {"thinking": False, "enable_thinking": False},
        }
    t0 = time.time()
    resp = await llm_client.chat.completions.create(**kwargs)
    _probe_reasoning(resp, time.time() - t0)
    ch = resp.choices[0]
    text = ch.message.content or ""
    truncated = (getattr(ch, "finish_reason", None) == "length")
    return text, truncated


async def llm_complete(system: str, messages: List[dict], max_tokens: int = 600) -> str:
    """두 백엔드 모두 같은 인터페이스로 호출 (비동기). 타임아웃 내 응답 없으면 예외.

    🆕 wrapper 모드 failover — 1차 모델 + WRAPPER_FALLBACKS 의 모델들을 순차 시도.
       타임아웃/DEGRADED/4xx/5xx 면 다음 모델로 자동 재시도. 모두 실패해야 비로소 raise.
    🆕 max_tokens 초과로 응답이 잘린 경우(finish_reason='length' / stop_reason='max_tokens'),
       한국어 종결 경계에서 깔끔히 트림."""
    if LLM_MODE == "wrapper":
        # 시도할 모델 체인: 1차 + fallback 들. 중복 제거하면서 순서 유지.
        chain: List[str] = [LLM_MODEL]
        for m in WRAPPER_FALLBACKS:
            if m and m not in chain:
                chain.append(m)
        last_exc: Optional[BaseException] = None
        for idx, model_id in enumerate(chain):
            try:
                text, truncated = await asyncio.wait_for(
                    _call_one_wrapper_model(model_id, system, messages, max_tokens),
                    timeout=LLM_TIMEOUT_SEC,
                )
                if idx > 0:
                    print(f"[FALLBACK OK] {chain[0]} 실패 → {model_id} 로 응답 받음")
                if truncated:
                    trimmed = _trim_to_complete_sentence(text)
                    print(f"[TRUNCATED] model={model_id} max_tokens={max_tokens} — "
                          f"종결 경계로 정제 ({len(text)}자 → {len(trimmed)}자)")
                    return trimmed
                return text
            except asyncio.TimeoutError as e:
                last_exc = LLMTimeoutError(f"LLM 응답 {LLM_TIMEOUT_SEC:.0f}s 초과 ({model_id})")
                print(f"[FALLBACK] {model_id} 타임아웃 — 다음 모델 시도")
                continue
            except Exception as e:
                last_exc = e
                if _is_failover_worthy(e):
                    print(f"[FALLBACK] {model_id} 실패 ({type(e).__name__}: "
                          f"{str(e)[:120]}) — 다음 모델 시도")
                    continue
                # 회피 불가 예외(파이썬 자체 버그·인증 실패 등) 는 즉시 raise
                raise
        # 모든 모델 실패 — 마지막 예외를 다시 raise
        if isinstance(last_exc, LLMTimeoutError):
            raise last_exc
        if last_exc:
            raise last_exc
        raise RuntimeError("llm_complete: empty model chain")

    # anthropic 모드 — 기존 로직 유지 (단일 모델, failover 없음)
    async def _call_anthropic() -> Tuple[str, bool]:
        resp = await llm_client.messages.create(
            model=LLM_MODEL,
            max_tokens=max_tokens,
            system=system,
            messages=messages,
        )
        text = resp.content[0].text
        truncated = (getattr(resp, "stop_reason", None) == "max_tokens")
        return text, truncated
    try:
        text, truncated = await asyncio.wait_for(_call_anthropic(), timeout=LLM_TIMEOUT_SEC)
    except asyncio.TimeoutError as e:
        raise LLMTimeoutError(f"LLM 응답 {LLM_TIMEOUT_SEC:.0f}s 초과") from e
    if truncated:
        trimmed = _trim_to_complete_sentence(text)
        print(f"[TRUNCATED] max_tokens={max_tokens} — 종결 경계로 정제 "
              f"({len(text)}자 → {len(trimmed)}자)")
        return trimmed
    return text


# 강한 종결자만 — 여는/닫는 따옴표는 구분이 애매해서 기본 경계로 쓰지 않는다.
# (예: 텍스트에 여는 `"` 가 마지막이면 그걸 종결자로 오인해 `일행을 둘러본다. "` 로 잘리는 버그 있었음.)
_STRONG_END = ('.', '!', '?', '。', '…', '\n')
# 강한 종결자 직후에 붙어있으면 함께 포함할 닫는 구두점 (예: `다." 형태).
_TRAILING_CLOSE = ('"', '"', '」', '』', "'", "'", ')', '〕', '】', ',')


def _trim_to_complete_sentence(text: str) -> str:
    """max_tokens 로 잘린 텍스트를 마지막 완결 문장까지만 남긴다.
    전략 (순서 중요):
      1) 미완 태그 `[... ` 는 잘라냄 (서버 파서가 반쪽 태그 오해 방지)
      2) 뒤에서부터 강한 종결자(., !, ?, …, 줄바꿈) 찾기 — 따옴표는 양방향 구분 불가라 제외
      3) 종결자 직후에 닫는 따옴표/괄호가 붙어있으면 포함
      4) 결과 내 `"` 카운트가 홀수면(= 열고 못 닫은 대사) 그 여는 따옴표 이전 종결자까지 재트림
      5) 경계 못 찾으면 원문 + `…`"""
    if not text:
        return text
    s = text.rstrip()
    # 1) 미완 태그 잔재 제거
    last_open = s.rfind('[')
    last_close = s.rfind(']')
    if last_open > last_close:
        s = s[:last_open].rstrip()
    # 2) 강한 종결자 탐색 (끝에서 400자 이내)
    search_start = max(0, len(s) - 400)
    best = -1
    for i in range(len(s) - 1, search_start - 1, -1):
        if s[i] in _STRONG_END:
            best = i
            break
    if best < 0:
        # 강한 종결자 전혀 없음 — 원문 뒤에 말줄임표
        return s + "…"
    # 3) 종결자 직후에 닫는 따옴표/괄호가 있으면 포함 (예: `갈라."` 의 `"`)
    end = best + 1
    while end < len(s) and s[end] in _TRAILING_CLOSE:
        end += 1
    result = s[:end].rstrip()
    # 4) 따옴표 밸런싱 — 짝 안 맞는 여는 따옴표가 있으면 그 앞 종결자까지 재트림.
    # (한국어 전각/반각 큰따옴표 혼용 대응: 총 `"` 와 `"` `"` 모두 세본 뒤 홀수 쪽 제거)
    def _imbalanced(txt: str) -> int:
        # 단순 근사: `"` 개수가 홀수면 마지막 `"` 위치 반환, 아니면 -1.
        ascii_q = [i for i, c in enumerate(txt) if c == '"']
        smart_open = [i for i, c in enumerate(txt) if c == '"']
        smart_close = [i for i, c in enumerate(txt) if c == '"']
        if len(ascii_q) % 2 == 1 and ascii_q:
            return ascii_q[-1]
        if len(smart_open) != len(smart_close):
            # 여는 게 더 많으면 마지막 여는 위치
            if len(smart_open) > len(smart_close) and smart_open:
                return smart_open[-1]
            if len(smart_close) > len(smart_open) and smart_close:
                return smart_close[-1]
        return -1

    imbalanced_at = _imbalanced(result)
    if imbalanced_at >= 0:
        # 그 따옴표 이전의 마지막 강한 종결자로 되돌아감.
        for i in range(imbalanced_at - 1, -1, -1):
            if result[i] in _STRONG_END:
                return result[:i + 1].rstrip()
        # 이전 종결자도 없으면 따옴표 직전까지.
        return result[:imbalanced_at].rstrip()
    return result

# ── 공통 스타일 ─────────────────────────────────
PORTRAIT_STYLE = (
    "dark fantasy CRPG character portrait, Baldur's Gate 3 concept art style, "
    "painterly digital oil painting, dramatic cinematic rim lighting, "
    "moody atmosphere, highly detailed face, intricate costume details, "
    "centered bust shot, solid dark background, artstation trending"
)

# ── 직업별 설정 ─────────────────────────────────
# 🆕 mp(마력) + equipped(장착 기본템 3슬롯: weapon/armor/accessory) 추가
CLASS_STATS = {
    "전사": {
        "hp": 120, "mp": 30, "attack": 15, "defense": 10, "gold": 50, "emoji": "⚔️",
        "equipped": {
            "weapon":    "녹슨 장검",
            "armor":     "가죽 흉갑",
            "accessory": "낡은 방패",
        },
        "weapon_options": [
            {"name": "녹슨 장검",    "emoji": "🗡️", "effect": "균형잡힌 한손검 — 출혈 확률 소폭"},
            {"name": "거대한 양손도끼", "emoji": "🪓", "effect": "양손 무기 — 공격력 +3, 속도 -1"},
            {"name": "뾰족한 창",    "emoji": "🔱", "effect": "긴 리치 — 선제공격 보너스"},
        ],
        "portrait": (
            "battle-hardened warrior, weathered scarred face, "
            "intricate engraved steel plate armor with fur-trimmed pauldrons, "
            "gripping a massive longsword, stern determined expression, "
            "ember-lit forge background glow"
        ),
    },
    "마법사": {
        "hp": 70, "mp": 150, "attack": 22, "defense": 5, "gold": 80, "emoji": "🔮",
        "equipped": {
            "weapon":    "견습생의 지팡이",
            "armor":     "수련자 로브",
            "accessory": "작은 마법서",
        },
        "weapon_options": [
            {"name": "견습생의 지팡이", "emoji": "🪄", "effect": "균형잡힌 지팡이 — MP 소비 -10%"},
            {"name": "서리 오브",      "emoji": "🔮", "effect": "냉기 주문 강화 — 슬로우 부여"},
            {"name": "화염 완드",      "emoji": "🔥", "effect": "화염 주문 강화 — 광역 피해 +15%"},
        ],
        "portrait": (
            "arcane wizard, piercing eyes glowing faint blue, "
            "ornate flowing velvet robes with silver arcane embroidery, "
            "holding a gnarled wooden staff crowned with a floating crystal, "
            "swirling magical runes in the air, mysterious aura"
        ),
    },
    "도적": {
        "hp": 90, "mp": 60, "attack": 18, "defense": 7, "gold": 70, "emoji": "🗡️",
        "equipped": {
            "weapon":    "쌍단검",
            "armor":     "어두운 가죽 갑옷",
            "accessory": "도둑의 밧줄",
        },
        "weapon_options": [
            {"name": "쌍단검",      "emoji": "🗡️", "effect": "2회 공격 — 치명타 확률 +10%"},
            {"name": "짧은 석궁",   "emoji": "🏹", "effect": "원거리 공격 — 은신 중 피해 +25%"},
            {"name": "독 바른 단도", "emoji": "🧪", "effect": "독 부여 — 매 턴 HP -3 (3턴)"},
        ],
        "portrait": (
            "cunning rogue, sharp features half-shadowed by a dark hood, "
            "studded leather armor with hidden buckles, twin curved daggers crossed, "
            "smirking lips, moonlit alley atmosphere, smoky background"
        ),
    },
    "성직자": {
        "hp": 100, "mp": 120, "attack": 10, "defense": 12, "gold": 60, "emoji": "✨",
        "equipped": {
            "weapon":    "축복받은 철퇴",
            "armor":     "성스러운 사제복",
            "accessory": "성표",
        },
        "weapon_options": [
            {"name": "축복받은 철퇴", "emoji": "🔨", "effect": "언데드에 추가 피해 +20%"},
            {"name": "성스러운 원드", "emoji": "🪄", "effect": "신성 주문 MP 소비 -20%"},
            {"name": "은빛 망치",    "emoji": "🔆", "effect": "치유 주문 +10% — 팀 버프"},
        ],
        "portrait": (
            "devoted cleric, serene wise face, "
            "ornate white and gold religious vestments with sacred engravings, "
            "holy symbol pendant glowing softly, wielding a blessed warhammer, "
            "divine golden light rays behind, kind but resolute expression"
        ),
    },
}

# ── 종족 ──────────────────────────────────────────
RACES = {
    "인간": {
        "emoji": "🧑",
        "portrait": "a human, strong jawline, determined eyes, weathered skin",
        "desc": "균형잡힌 종족. 다재다능하고 어디든 적응한다.",
    },
    "엘프": {
        "emoji": "🧝",
        "portrait": "an elf, pointed ears, graceful slender features, ethereal long hair, mystical luminous eyes",
        "desc": "고귀한 숲의 수호자. 우아하고 지적이다.",
    },
    "드워프": {
        "emoji": "🧔",
        "portrait": "a dwarf, stocky sturdy build, braided beard with iron rings, rugged features, broad shoulders",
        "desc": "산악의 장인. 강인하고 고집스럽다.",
    },
    "하플링": {
        "emoji": "🧒",
        "portrait": "a halfling, small-statured, curly hair, cheerful mischievous smile, nimble posture",
        "desc": "작은 방랑자. 민첩하고 행운이 따른다.",
    },
    "오크": {
        "emoji": "👹",
        "portrait": "an orc, muscular powerful build, protruding lower tusks, green-tinged skin, fierce warrior scars",
        "desc": "강대한 전사 종족. 야성과 힘의 화신.",
    },
    "티플링": {
        "emoji": "😈",
        "portrait": "a tiefling, curving horns, reddish purple skin, glowing amber eyes, pointed tail visible, demonic lineage",
        "desc": "악마의 피가 흐르는 자. 매혹적이고 위험하다.",
    },
    "드래곤본": {
        "emoji": "🐉",
        "portrait": "a dragonborn, reptilian scaled face, draconic snout, horns, metallic scales catching light",
        "desc": "용의 후예. 고대의 피를 잇는다.",
    },
    "놈": {
        "emoji": "🧙",
        "portrait": "a gnome, tiny statured, bright curious eyes, wild unkempt hair, inventor's apron, spectacles",
        "desc": "기괴한 발명가. 호기심이 생명이다.",
    },
    # 🆕 수인 — 동물 종류 + 인간/동물 비율을 따로 지정. portrait 는 빌더가 ratio 로 생성.
    "수인": {
        "emoji": "🦊",
        "portrait": "a beastfolk hybrid",  # 폴백 — 실제로는 build_portrait_url 에서 동물+비율로 덮어씀
        "desc": "인간과 짐승 사이의 혈통. 동물과 비율은 직접 선택한다.",
    },
}

# ── 수인 동물 옵션 + ratio 별 프롬프트 ────────────
#  ratio 는 10~90 의 **연속값** (0=순수 인간, 100=순수 짐승은 정체성상 "수인" 이 아니므로 금지).
#  아래 5단 버킷(20 간격)으로 세분화. 33 / 34 같은 날카로운 경계 대신, 5단계로 그림 변화가 슬라이더에 반영된다.
#  각 단계마다 "human vs animal influence" 가중치를 자연어로 명시 → Flux 가 퍼리 아트로 치우치지 않게 인간 톤을 계속 유지.
BEASTFOLK_ANIMALS: Dict[str, Dict[str, str]] = {
    "늑대":    {"emoji": "🐺", "name_en": "wolf",
                "trait_low":  "subtle wolf ears peeking through hair and a small wolf tail, faint canine hints",
                "trait_mid1": "wolf ears, wolf tail, sharpened canine teeth, piercing yellow irises",
                "trait_mid":  "wolf muzzle starting to form, patches of grey fur along jawline and arms, wolf ears and tail",
                "trait_mid2": "partial wolf snout, thick grey fur across face and shoulders, lupine eyes, mostly human silhouette",
                "trait_high": "wolf-like muzzle with fangs, dense grey fur across face, pointed lupine ears, human body with lupine features"},
    "여우":    {"emoji": "🦊", "name_en": "fox",
                "trait_low":  "slender fox ears and a fluffy fox tail, sly glint in human eyes",
                "trait_mid1": "fox ears, bushy red tail, small sharp fangs, narrow cunning eyes",
                "trait_mid":  "slender fox muzzle hinted, reddish fur around cheekbones, fox ears and bushy tail",
                "trait_mid2": "fox snout with reddish fur across face, fox ears and swishing tail, mostly human body",
                "trait_high": "fox muzzle with small fangs, red fur covering face, pointed vulpine ears, human body with vulpine features"},
    "호랑이":  {"emoji": "🐯", "name_en": "tiger",
                "trait_low":  "tiger ears and striped tiger tail, faint orange undertone on skin",
                "trait_mid1": "tiger ears, long striped tail, amber feline eyes, subtle orange tabby markings on cheekbones",
                "trait_mid":  "orange-and-black stripes across cheekbones and arms, hint of a tiger muzzle, tiger ears and tail",
                "trait_mid2": "partial tiger snout with fangs, orange striped fur across face and shoulders, imposing presence",
                "trait_high": "tiger muzzle with fangs, orange and black striped fur across face, feline ears, powerful human body with tiger features"},
    "고양이":  {"emoji": "🐱", "name_en": "cat",
                "trait_low":  "cat ears peeking through hair and a slender cat tail, slit-pupil eyes",
                "trait_mid1": "cat ears, long swishing cat tail, slit pupils, small pointed fangs",
                "trait_mid":  "small cat muzzle hinted, short fur along jawline, cat ears and tail, graceful posture",
                "trait_mid2": "partial cat snout, short fur across face and arms, cat ears and swishing tail",
                "trait_high": "cat muzzle with small fangs, short fur covering face, pointed feline ears, human body with feline features"},
    "토끼":    {"emoji": "🐰", "name_en": "rabbit",
                "trait_low":  "tall rabbit ears emerging from hair and a small fluffy tail, twitching nose",
                "trait_mid1": "long upright rabbit ears, short fluffy tail, wide alert eyes, small buck teeth",
                "trait_mid":  "soft short fur along jawline, hint of a rabbit muzzle, tall rabbit ears",
                "trait_mid2": "partial rabbit muzzle with buck teeth, soft fur across face, long upright rabbit ears",
                "trait_high": "rabbit muzzle with buck teeth, soft fur covering face, tall upright rabbit ears, human body with lapine features"},
    "곰":      {"emoji": "🐻", "name_en": "bear",
                "trait_low":  "small rounded bear ears, subtle brown fur trim along jawline, broad shoulders",
                "trait_mid1": "rounded bear ears, thick brown fur along neck and jaw, broad frame, kind deep-set eyes",
                "trait_mid":  "hint of a bear muzzle, thick brown fur across cheeks and arms, powerful rounded ears",
                "trait_mid2": "partial bear snout, dense brown fur across face and shoulders, massive build",
                "trait_high": "ursine muzzle with blunt teeth, dense brown fur covering face, rounded bear ears, massive human body with bear features"},
}

# 수인 비율 허용 범위 — 0/100 은 "수인" 정체성 경계에서 모순이라 금지.
BEASTFOLK_RATIO_MIN = 10
BEASTFOLK_RATIO_MAX = 90


# ── DND PHB 스타일 6 능력치 (Phase 1) ─────────────
# 모든 캐릭터는 6개의 ability score 를 가짐. 기본값 10 + 종족 보정 + 동물 보정(수인).
# - 근력(strength) STR — 물리 공격, 들어올리기, 무기 위력
# - 지능(intelligence) INT — 마법 위력, 지식, 전술
# - 지혜(wisdom) WIS — 인지·통찰·자제력·마법 저항
# - 기교(dexterity) DEX — 속도(턴 순서·initiative), 회피, 도적 판정, 정밀
# - 매력(charisma) CHA — NPC 반응, 사교, 거래 — **생성 시점에 종족 보정만 적용 후 고정**, 레벨업 X
# - 건강(constitution) CON — HP 베이스, 독·질병 저항, 체력
# 5e PHB 의 표준 종족 보정을 한국어 종족 라인업에 맞춰 변환.
ABILITY_KEYS = ("strength", "intelligence", "wisdom", "dexterity", "charisma", "constitution")
ABILITY_LABELS_KR = {
    "strength":     "근력",
    "intelligence": "지능",
    "wisdom":       "지혜",
    "dexterity":    "기교",
    "charisma":     "매력",
    "constitution": "건강",
}
# 매력은 생성 시 고정. 나머지 5개만 레벨업 spend_stat_point 로 올릴 수 있음.
LEVELABLE_ABILITIES = ("strength", "intelligence", "wisdom", "dexterity", "constitution")

# 종족별 능력치 보정 — 5e PHB 참고. 합계가 종족 파워에 비례 (보통 +2 ~ +4).
RACE_ABILITY_MOD: Dict[str, Dict[str, int]] = {
    "인간":     {"strength": 1, "intelligence": 1, "wisdom": 1, "dexterity": 1, "charisma": 1, "constitution": 1},
    "엘프":     {"dexterity": 2, "intelligence": 1, "constitution": -1},
    "드워프":   {"constitution": 2, "strength": 1, "charisma": -1},
    "하플링":   {"dexterity": 2, "charisma": 1, "strength": -1},
    "오크":     {"strength": 2, "constitution": 1, "intelligence": -1},
    "티플링":   {"charisma": 2, "intelligence": 1, "wisdom": -1},
    "드래곤본": {"strength": 2, "charisma": 1, "constitution": 1, "wisdom": -1},
    "놈":       {"intelligence": 2, "constitution": 1, "strength": -1},
    "수인":     {},  # 수인은 동물별 보정으로 계산 (BEASTFOLK_ABILITY_MOD)
}

# 수인 동물별 능력치 보정 — 동물 본성을 반영. 종족 보정 위에 추가로 합산.
BEASTFOLK_ABILITY_MOD: Dict[str, Dict[str, int]] = {
    "늑대":   {"strength": 1, "dexterity": 1, "wisdom": 1},
    "여우":   {"dexterity": 2, "intelligence": 1, "charisma": 1},
    "호랑이": {"strength": 2, "constitution": 1, "charisma": 1},
    "고양이": {"dexterity": 2, "charisma": 1, "intelligence": 1},
    "토끼":   {"dexterity": 2, "wisdom": 1, "constitution": -1},
    "곰":     {"strength": 2, "constitution": 2, "dexterity": -1},
}

ABILITY_BASE = 10  # 표준 평균
ABILITY_MIN = 3    # 일반 캐릭터 최저
ABILITY_MAX = 30   # 영웅적 상한 (DND 5e 와 동일)

# 🆕 포인트 바이 (대기실 능력치 사전 조정)
# 모든 캐릭터는 6 능력치 모두 10 으로 시작 (총합 60). 대기실에서 [7, 13] 범위로 ±1 씩 재분배.
# 총합 60 을 유지해야 "준비 완료" 가능 (UI 가 강제). 게임 시작 시 종족·동물 보정이 random 1~3 추가 적용.
PREGAME_STAT_MIN = 7
PREGAME_STAT_MAX = 13
PREGAME_TOTAL_BUDGET = 60


def compute_ability_scores(race: Optional[str], race_animal: Optional[str]) -> Dict[str, int]:
    """🆕 종족 + (수인이면) 동물 보정을 합쳐 6 능력치 초기값 산출. 캐릭터 생성 시 1회 호출."""
    scores = {k: ABILITY_BASE for k in ABILITY_KEYS}
    race_mod = RACE_ABILITY_MOD.get(race or "", {})
    for k, v in race_mod.items():
        scores[k] = max(ABILITY_MIN, min(ABILITY_MAX, scores[k] + int(v)))
    if race == "수인" and race_animal in BEASTFOLK_ABILITY_MOD:
        for k, v in BEASTFOLK_ABILITY_MOD[race_animal].items():
            scores[k] = max(ABILITY_MIN, min(ABILITY_MAX, scores[k] + int(v)))
    return scores


# 🆕 DM 본문에서 "STR 16 의 압도적인 근력" 같은 직접 수치 노출 제거 (몰입감 보호 안전망).
# 프롬프트만으로는 LLM 이 종종 따르지 않아서 후처리 필터로 강제. 형용사·뒤 서술은 그대로 보존.
_STAT_KEYWORDS = r'(?:STR|INT|WIS|DEX|CHA|CON|근력|지능|지혜|기교|매력|건강)'
_KO_PARTICLES = r'(?:의|이|가|은|는|를|을|에|로|라|으로|이라|로서|으로서|짜리|만큼|와|과|에도|로도|에서|점|점의|점이|짜리의)'

# 조사를 0~2회 반복 매칭 — "8 점의" 처럼 "점" + "의" 같이 두 단계로 붙는 케이스 처리.
_PARTICLE_TAIL = rf'(?:{_KO_PARTICLES}\s*){{0,2}}'
# 패턴 1: 키워드 → 숫자 → (조사 1~2개) 순서. "STR 16 의", "근력 8 점의"
_STAT_NUM_FORWARD = re.compile(
    rf'\(?\s*{_STAT_KEYWORDS}\s*[:=]?\s*\d+\s*\)?\s*{_PARTICLE_TAIL}',
    re.IGNORECASE,
)
# 패턴 2: 숫자 → 키워드 → (조사) 순서. "10 STR 의", "14 근력"
_STAT_NUM_REVERSE = re.compile(
    rf'\(?\s*\d+\s*{_STAT_KEYWORDS}\s*\)?\s*{_PARTICLE_TAIL}',
    re.IGNORECASE,
)

def _strip_numeric_stat_mentions(text: str) -> str:
    """DM 본문에서 능력치 점수 직접 노출을 제거. 양방향 매칭(`STR 16 의` / `16 STR 의` 둘 다)."""
    if not text:
        return text
    text = _STAT_NUM_FORWARD.sub('', text)
    text = _STAT_NUM_REVERSE.sub('', text)
    return text


# 🆕 수인 비율 % 직접 언급 제거. 시스템 프롬프트에 "참고용, 직접 언급 금지" 라고 적어도 LLM 이 종종 새어나옴.
# 예: "70% 수인화된 체격", "수형 50%", "곰의 피가 70%", "25% 비율의 인간형"
_BEAST_PERCENT_PATTERNS = [
    # \d+% (수인|수형|인간형|반수인|화/된/의/...)
    re.compile(
        r'\d+\s*%\s*(?:수인화?|수형화?|인간형|반수인|짐승|혈통|비율)(?:된|의|이|가|으로|로)?\s*',
        re.IGNORECASE,
    ),
    # (수인|수형|...) \d+%
    re.compile(
        r'(?:수인|수형|인간형|반수인|짐승|혈통|비율)\s*\d+\s*%\s*(?:의|이|가|으로|로|짜리)?\s*',
        re.IGNORECASE,
    ),
    # (곰|호랑이|...)의 피가 \d+% / 곰 \d+%
    re.compile(
        r'(?:곰|호랑이|여우|늑대|토끼|고양이|뱀|매)(?:의)?\s*(?:피가|혈통이?)?\s*\d+\s*%\s*'
        r'(?:의|이|가|으로|로|드러난다|흐른다|섞였다)?\s*',
    ),
]


def _strip_beastfolk_percent(text: str) -> str:
    """수인 비율 직접 노출 ('70% 수인화된 체격', '수형 50%' 등) 제거."""
    if not text:
        return text
    for pat in _BEAST_PERCENT_PATTERNS:
        text = pat.sub('', text)
    return text


# 🆕 한자(CJK 통합 한자) 침범 정리. LLM 이 가끔 중국어/일본어 한자를 흘림.
# 예: "들试图하지만" → "들하지만". 단순 제거 + 연속 공백 압축.
# 한국어 어원 한자(漢字) 도 같이 제거되긴 하나, 이번 게임에선 발생 빈도 거의 0.
_HANJA_PATTERN = re.compile(r'[一-鿿㐀-䶿]+')

def _strip_hanja(text: str) -> str:
    """한자 제거 + 인접 공백 정리. 한국어 본문에 한자가 섞이면 거의 100% LLM 의 다국어 누수."""
    if not text:
        return text
    cleaned = _HANJA_PATTERN.sub('', text)
    # 제거 후 공백/특수문자 정리: 연속 공백 → 1개, 괄호 안이 비면 () 삭제
    cleaned = re.sub(r'\(\s*\)', '', cleaned)
    cleaned = re.sub(r'[ \t]{2,}', ' ', cleaned)
    return cleaned


def _sanitize_dm_text(text: str) -> str:
    """🆕 DM 응답 사후 후처리 — 몰입감 보호 + LLM 다국어 누수 정리.
    호출 순서: 능력치 숫자 → 수인 % → 한자.
    각 함수가 독립적이라 순서가 중요하지 않지만, 한자 정리는 마지막에 두어 공백 압축이 잘 되게."""
    if not text:
        return text
    text = _strip_numeric_stat_mentions(text)
    text = _strip_beastfolk_percent(text)
    text = _strip_hanja(text)
    return text


def ability_modifier(score: int) -> int:
    """🆕 영점(10) 기준 대칭 modifier 공식: 10 에서 멀어질수록 ±1 씩 (2점당).
    DND 5e 의 floor 식은 비대칭(예: 9→-1, 11→0)이라 직관적이지 않아 truncate-toward-zero 채택.

    | 점수 | 7  | 8  | 9 | 10 | 11 | 12 | 13 |
    | mod  | -1 | -1 | 0 | 0  | 0  | +1 | +1 |
    | 14   | +2 | 16 | +3 | 18 | +4 | 20 | +5 |  (높은 쪽도 같은 패턴)
    """
    s = int(score)
    if s >= 10:
        return (s - 10) // 2
    return -((10 - s) // 2)


def pick_random_race() -> str:
    # 🆕 수인은 추가 설정(동물/비율) 필요하므로 '랜덤 배정' 대상에서 제외.
    pool = [r for r in RACES.keys() if r != "수인"]
    return random.choice(pool)


def _beastfolk_portrait(animal: str, ratio: int) -> str:
    """수인 초상화 프롬프트 — 5단 버킷으로 슬라이더 변화를 반영.
    ratio 는 호출 전에 validate_race_params 에서 [10, 90] 로 보장됨.

    ⚙ 프롬프트 설계: Flux 는 **앞쪽 토큰의 composition 지배력이 강함**. 비율별 시각 특징을
    맨 앞에 배치하고, 버킷마다 서로 다른 키워드(face vs muzzle, fur 밀도 등) 로 구성해
    직업·스타일 토큰이 뒤에 붙어도 특징이 묻히지 않게 한다."""
    a = BEASTFOLK_ANIMALS[animal]
    en = a["name_en"]
    r = int(ratio)
    # 각 버킷: (head descriptor, body descriptor, explicit % anchor)
    if r <= 25:
        return (
            f"human face with {a['trait_low']}, human skin tone, fully human head shape, "
            f"only subtle {en} hints (ears and tail), human body, "
            f"dark fantasy CRPG hero portrait, beastfolk with mostly human appearance"
        )
    elif r <= 45:
        return (
            f"mostly human face with {a['trait_mid1']}, human facial structure, "
            f"visible but not dominant {en} features, human body, "
            f"dark fantasy CRPG hero portrait, beastfolk — noticeably human with {en} traits"
        )
    elif r <= 55:
        return (
            f"half-human half-{en} hybrid head with {a['trait_mid']}, "
            f"partial {en} muzzle blending with human face, balanced fur-and-skin mix on cheekbones, "
            f"clearly chimeric appearance, humanoid body, dark fantasy CRPG hero portrait, beastfolk hybrid"
        )
    elif r <= 70:
        return (
            f"{en}-dominant head with {a['trait_mid2']}, prominent {en} snout, dense {en} fur across face and neck, "
            f"humanoid body with {en}-like musculature, "
            f"dark fantasy CRPG hero portrait, heavily {en}-featured beastfolk warrior"
        )
    else:
        return (
            f"{a['trait_high']}, full {en} muzzle, face completely covered in {en} fur, {en} head on a human body, "
            f"dark fantasy CRPG hero portrait, beastfolk with predominantly {en} features, "
            f"still a humanoid hero (not a furry animal character)"
        )


def validate_race_params(race: Optional[str],
                         race_animal: Optional[str],
                         race_ratio) -> Tuple[Optional[str], Optional[int], Optional[str]]:
    """수인 관련 서브 파라미터 검증. 반환: (정제된 animal, 정제된 ratio, error_msg|None).
    race != 수인 이면 (None, None, None) 반환."""
    if race != "수인":
        return None, None, None
    if race_animal not in BEASTFOLK_ANIMALS:
        allowed = " / ".join(BEASTFOLK_ANIMALS.keys())
        return None, None, f"지원하지 않는 동물입니다: {race_animal!r}. 선택 가능: {allowed}"
    try:
        r = int(race_ratio)
    except (TypeError, ValueError):
        return None, None, "수인 비율이 잘못된 형식입니다 (정수가 필요)."
    if r < BEASTFOLK_RATIO_MIN or r > BEASTFOLK_RATIO_MAX:
        return None, None, (
            f"수인 비율은 {BEASTFOLK_RATIO_MIN}~{BEASTFOLK_RATIO_MAX}% 범위여야 합니다 "
            f"(0%는 '인간' 종족과 구별 불가, 100%는 정체성이 '짐승'이 됩니다)."
        )
    return race_animal, r, None


def build_portrait_url(character_class: str, race: str, name: str,
                       race_animal: Optional[str] = None,
                       race_ratio: Optional[int] = None) -> str:
    """Pollinations.ai 이미지 URL — 종족+직업 조합 기반. 수인은 동물/비율 까지 반영.

    ⚙ 수인일 때는 직업 portrait 에서 얼굴 관련 토큰(weathered scarred face 등) 을 쓰지 않는다.
    직업 토큰이 '인간 얼굴' 을 강하게 암시해서 수인 특징이 상쇄되는 걸 방지."""
    cls_info = CLASS_STATS.get(character_class, CLASS_STATS["전사"])
    if race == "수인":
        race_portrait = _beastfolk_portrait(race_animal or "늑대", race_ratio if race_ratio is not None else 50)
        # 수인은 장비·직업 실루엣만 (얼굴 표현은 beastfolk 토큰에 양보)
        class_cue = cls_info.get("portrait_gear") or _extract_gear_only(cls_info["portrait"])
        prompt = f"{race_portrait}, {class_cue}, {PORTRAIT_STYLE}"
    else:
        race_info = RACES.get(race, RACES["인간"])
        race_portrait = race_info["portrait"]
        prompt = f"{race_portrait}, {cls_info['portrait']}, {PORTRAIT_STYLE}"
    encoded = urllib.parse.quote(prompt)
    # 수인은 동물/비율이 바뀌면 시드도 바뀌어서 이미지가 새로 생성됨
    seed_key = f"{name}-{character_class}-{race}-{race_animal or ''}-{race_ratio if race_ratio is not None else ''}"
    seed = int(hashlib.md5(seed_key.encode()).hexdigest()[:8], 16)
    return (
        f"https://image.pollinations.ai/prompt/{encoded}"
        f"?width=384&height=384&seed={seed}&nologo=true&model=flux"
    )


def _extract_gear_only(class_portrait: str) -> str:
    """직업 portrait 텍스트에서 '얼굴/표정' 어구를 걸러내고 장비·자세 키워드만 추출.
    수인 전용 프롬프트 구성 시 사용 — '인간 얼굴' 암시가 수인 트레이트를 덮는 걸 방지.
    필터는 좁게 (face / eyes / expression / beard 정도) — 너무 많이 거르면 장비 묘사까지 날아감."""
    face_markers = ("face", "eyes", "expression", "beard")
    parts = [p.strip() for p in class_portrait.split(",")]
    kept = [p for p in parts if not any(m in p.lower() for m in face_markers)]
    return ", ".join(kept) if kept else class_portrait


DM_SYSTEM_PROMPT = """당신은 어두운 판타지 RPG의 던전 마스터입니다. 발더스 게이트 스타일의 세계를 배경으로 합니다.

## 톤 & 스타일
- 반드시 한국어로 응답하세요
- **플레이어 이름의 뉘앙스를 반드시 서사에 녹여라**. 예시:
  · "허접" "찐따" 같은 자조적/웃긴 이름 → 위트와 자조적 농담 섞기. NPC들이 이름 듣고 피식하거나 비꼬는 반응.
  · "강철왕" "드래곤슬레이어" 같은 거창한 이름 → 서사시 톤. 이름에 걸맞은 칭송이나 위압감.
  · 평범한 이름 → 표준 판타지 톤.
- 종족 특성도 적극 활용 (엘프의 예민한 감각, 오크의 야성, 티플링의 악마적 시선 등)
- **수인은 파티 요약에 `수인(동물·구간·%)` 형식으로 주어짐**. 이건 **너만 보는 참고 정보**이고, 서사에서는 **숫자/% 와 동물명을 닉네임 앞에 붙이지 말 것**.
  · ❌ 금지: "90% 호랑이 수인 덕배가 포효했다", "수인(호랑이·수형·90%) 덕배"
  · ✅ 권장: "덕배가 낮게 포효했다. 짐승에 가까운 송곳니가 드러났다", "덕배의 호랑이 꼬리가 휙 휘어졌다"
  · 비율에 따라 **묘사의 결**을 바꿔라 (말투·NPC 반응·감각). 숫자 자체를 언급하지 마라.
  · 비율 25% 이하: 인간 모습에 동물 귀·꼬리 수준. NPC 반응은 "호기심 섞인 시선"
  · 비율 45~55%: 얼굴에 털·주둥이가 드러난 혼혈. 노골적 시선/편견 섞임
  · 비율 70% 이상: 짐승에 가까운 모습. 거친 위압감, 때로 경계·배척 받음 (단 여전히 휴머노이드 영웅, 퍼리 캐릭터 아님)
  · 비율에 따라 감각 묘사도 달라짐 (인간형=미묘한 청각, 수형=본능적 사냥감 냄새 인지 등)
  · 동물 특성을 행동·대사에 자연스레 녹이기 (토끼=경계심·빠른 도주, 호랑이=포효·우월감, 고양이=여유·장난기)
- 생생하고 극적인 묘사 (3~5문장, 응답은 **350자 이내**)
- 너무 딱딱하지 말고 캐릭터 개성을 살려라. NPC 대사에 사투리/악센트/말투를 섞어도 좋다.

## 필수 포맷 (정확히 이대로)
- 응답 **맨 첫 줄**: 시간대 태그. 다음 중 하나로 **정확히**:
  `[🌅 새벽]` `[☀️ 아침]` `[🌞 정오]` `[🌆 황혼]` `[🌙 밤]` `[🌌 심야]`
  (하루가 지나 다시 새벽/아침이 오는 자연스러운 시간 경과는 허용된다 — 서버가 자동으로 일차를 +1. 같은 하루 안에서는 이전 시간대로 거꾸로 돌아가지 말 것.)
- **플레이어 이름은 파티 요약에 적힌 그대로 사용**. 줄임/수식어 없이 정확히 써야 HP/XP 같은 태그가 올바른 대상에 적용된다. ("용사 허접" 대신 "허접".)
- 플레이어 **이름을 정확히 모르겠으면 태그를 찍지 말고** 서술만 할 것.
- **XP 태그는 반드시 이름 포함**: `[이름 XP +N]`. `[XP +35]` 처럼 이름 빠뜨리면 고아 태그가 되어 서버가 추측으로 복구해야 한다 (행동자에게 귀속됨). 피할 수 있으면 피해라.
- **DM 주사위 굴림은 반드시 이 포맷**: `[🎲DM d20: X]` 또는 `[🎲DM d6: X]` 등.
  (DM이 굴리는 어떤 주사위든 반드시 `🎲DM` 접두사 사용. 플레이어가 굴린 주사위는 클라이언트가 자동 중계함.)
  예: `적의 반격 명중 판정 [🎲DM d20: 14]`
- **주사위 결과를 서술과 모순되지 않게 써라.** d20:1 (크리티컬 실패) 을 굴려놓고 "명중!" 으로 서술하면 플레이어가 혼란. 주사위 결과가 서사를 지배해야 한다. 실패 주사위 = 서사도 실패/차선책.
- HP 변화: `[이름 HP: X → Y]` — 이 포맷 정확히. 복수면 각 줄에.
- 마력(MP) 변화: `[이름 MP: X → Y]` — 주문 시전 시 소모, 휴식/포션 시 회복.
- 전투/치유 있으면 언제나 HP/MP 반영.

## 서식 (클라이언트가 렌더링함 — 반드시 이 스타일 준수)
- **NPC 대사는 반드시 큰따옴표 `"..."` 로 감싸라.** 예시:
  > 노파가 떨리는 목소리로 속삭였다. "볼카르가 돌아왔어… 오직 너희만이 희망이야."
- **장면 묘사와 대사는 빈 줄(\n\n)로 단락 분리하라.** 한 덩어리 글 금지.
- 강조가 필요하면: **굵게** 또는 `<b>굵게</b>`, *기울임* 또는 `<i>기울임</i>`
- 마크다운(`**`, `*`)과 HTML 태그(`<b>`, `<i>`, `<em>`, `<strong>`, `<u>`) 둘 다 지원됨. 섞어 써도 OK.
- 줄바꿈이 필요한 단락은 실제 줄바꿈 문자 사용 (`<br>` 대신).

## 좋은 예시 구조
```
[🌆 황혼]

붉은 노을이 잿빛 성벽을 핏빛으로 물들인다. 파티는 무너진 성문 앞에 선다.

성문 옆에 쭈그려 앉은 **늙은 파수꾼**이 눈을 들어 일행을 본다.

"…기다렸네. 오래 기다렸어."
```

## 몬스터 관리 (전투 시작 ~ 종료까지 **반드시 사용**)
적이 전투에 참여하면 이 태그로 상태를 관리하세요. 파티 패널 하단 '몬스터' 카드로 자동 노출됩니다.
**개별 유닛 단위**로 관리: 같은 종족이라도 A/B/C 또는 "우두머리" 등으로 이름을 구분하세요.
- **등장**: `[적 등장: 고블린 A | HP 12]` — 전투 시작 때 적 하나당 한 줄씩 (3기면 3줄)
- **HP 변화**: `[적 HP: 고블린 A 12 → 5]` — 공격/치유로 HP 바뀔 때. 0 이 되면 자동 제거됨
- **상태 메모**: `[적 상태: 고블린 A | 넘어짐 — 다음 공격 +4 유리]` — 짧은 한 줄 묘사. 빈 값이면 해제
- **버프**: `[적 버프: 고블린 A | 가속 2턴 | 회피 +20%]` — 적에게 일시 버프 (지속 턴 명시)
- **디버프**: `[적 디버프: 고블린 A | 독 3턴 | 매 턴 -4 HP]` — DOT(매 턴 피해) 효과명에 숫자(예: "-4 HP", "5 데미지")가 있으면 **서버가 라운드마다 자동으로 HP 깎음**. 명시하지 않으면 서술용일 뿐 HP 안 깎임.
- **⚠ 중요 — 상태이상을 서술하면 반드시 태그도 찍어라**:
  - "독이 퍼진다", "마비된다", "출혈한다", "화상을 입는다" 등 DOT/상태이상 키워드를 서사에 쓰면 **같은 응답 내에 반드시 `[적 디버프: 이름 | 효과 N턴 | 매 턴 -N HP]` 태그**를 찍어라.
  - 서술만 하고 태그 안 찍으면 서버는 상태를 모름 → 다음 턴에 자동 HP 감소 안 됨 → 독 단검을 썼는데 적이 멀쩡한 모순 발생.
  - 아이템 효과(독 단검, 불꽃 화살 등)로 인한 상태이상도 반드시 태그화.
- **퇴장**: `[적 퇴장: 고블린 A]` — 도망·합류·합체 등 HP 0 아닌 소멸

### ⚠ NPC → 적 전환 시 (반드시 [적 등장] 다시 찍기)
- 처음엔 평범한 NPC 였던 인물(촌장·성직자·왕의 사자 등)이 갈등 끝에 적대적이 되면, 그 순간 **반드시 `[적 등장: 이름 | HP X]` 태그를 찍어** 전투 추적 가능 상태로 전환.
- 안 찍으면 클라이언트는 그 인물을 그냥 "서사 속 NPC" 로 간주 → HP 바·체력 추적·처치 XP 모두 작동 안 함.
- 예시: 마을 성직자 오스윈이 정체를 드러내며 공격 → `[적 등장: 오스윈 | HP 30]` 즉시 발화. 이후 평소대로 `[적 HP: 오스윈 ...]` 관리.
- 반대로 적이었던 자가 항복·동맹 전환되면 `[적 퇴장: 이름]` 으로 카드 정리 후 NPC 로 서술만.

### ⚠ 전투 종료 시 — 살아남은 적 정리
- 전투가 마무리되면(도망·항복·교섭 성공·일행 이탈·시야에서 사라짐 등) **남아있는 적 카드를 반드시 `[적 퇴장: 이름]` 으로 정리**.
- 안 하면 전투 끝났다고 서술해도 UI 에는 적 카드가 그대로 떠 있어서 플레이어 혼란.
- HP 0 으로 죽인 적은 자동 제거되니 따로 안 찍어도 됨. 그 외 모든 이탈은 명시적 태그.

- 등장 때 정한 **풀네임을 이후 태그에서 그대로 재사용**. ("고블린 A" 로 등장시켰으면 계속 "고블린 A" — 약칭 "A" 로 쓰지 말 것)
- ❌ **금지**: "⚔ 전투 중 — A/B/C(HP 12)" 같은 텍스트 상태요약. 태그만 써도 UI 가 자동 표시함

### 처치/어시스트 XP 는 자동 지급
- 적의 HP 가 0 이 되면 **마지막 공격자 = 처치자**, 그 외 한 번이라도 때린 사람 = 어시스트로 **서버가 자동 XP 분배**.
  → DM 은 일반 전투 처치에는 `[XP +N]` 태그를 **굳이 따로 찍을 필요 없음**.
- `[XP +N]` 은 **전투 외 성취** (창의적 해결, 퀘스트 완수, 거래 성공 등) 에만 보너스로 사용.

## 경험치 & 레벨업 (선택)
- 의미있는 성취(전투 승리, 퀘스트 완수, 창의적 해결)에는 XP 부여:
  `[이름 XP +N]` (전투 승리 20~40, 일반 기여 5~15, 대담한 한 수 50+)
- **1회 태그 당 최대 200, 한 응답 전체 누적 최대 500 이 서버 상한**. 이를 넘는 값은 잘려나감.
- 레벨업은 서버가 자동 처리하니 태그만 찍으면 됨. **남발 금지** — 서사에 어울릴 때만.
- 레벨업 시 서버는 HP/MP 를 풀회복하지 않고 **증가분만** 현재 수치에 더한다. 따라서 "간신히 살아남은 채 레벨업" 같은 서사를 그대로 유지해도 수치가 모순되지 않는다.

## 아이템 획득 & 효과 & 사용 (중요)
### 획득
- **효과 즉시 공개** (권장): `[이름 획득: 아이템명 | 효과 설명]`
  예: `[허접 획득: 치유 물약 | HP 30 즉시 회복]`
- **감정 필요/미확인**: `[이름 획득: 아이템명]` — 클라이언트에 "아직 알 수 없음" 표시
  예: `[허접 획득: 볼카르 인장 반지]`
- **수량이 여럿이면 `x숫자`**: `[이름 획득: 건빵 x5]` 또는 `[이름 획득: 건빵 x5 | 배고픔 완화]`
- **장비/소모품 종류 명시 (권장)** — 가운데 칸에 종류 키워드, 마지막 칸에 효과:
  `[이름 획득: 강철검 | 무기 | 공격 +5, 출혈 10%]` (자동으로 무기 슬롯에 장착, 기존 무기는 인벤토리로 회수)
  `[이름 획득: 사슬 갑옷 | 방어구 | 방어 +4]` (자동 방어구 장착)
  `[이름 획득: 매혹의 반지 | 장신구 | CHA 판정 +2]` (자동 장신구 장착)
  `[이름 획득: 치유 물약 x3 | 소모품 | HP 30 즉시 회복]` (소모품 — '사용' 버튼으로 발동)
  `[이름 획득: 볼카르 인장 | 퀘스트]` (퀘스트 아이템 — 사용·장착 X)
  종류 키워드: `무기` / `방어구` / `장신구` / `소모품` / `퀘스트`. 미지정은 `소모품` 으로 간주.

### 효과 뒤늦게 밝히기
- 이미 인벤토리에 있는 아이템의 효과를 공개 — **대상 플레이어 명시 권장**:
  `[아이템 효과: 플레이어명 | 아이템명 | 효과 설명]`
  예: `[아이템 효과: 허접 | 볼카르 인장 반지 | 적 진영에서 위장 효과 (조건부)]`
  (플레이어 생략형 `[아이템 효과: 아이템명 | 설명]` 은 **그 아이템을 가진 플레이어가 파티 내에 1명일 때만** 서버가 적용한다. 2명 이상이 같은 이름의 아이템을 들고 있으면 무시됨.)
- 장착 중인 장비의 효과를 공개 — **대상 플레이어 명시 권장**:
  `[장비 효과: 플레이어명 | 장비명 | 효과 설명]`
  예: `[장비 효과: 허접 | 녹슨 장검 | 공격 시 10% 확률로 출혈 부여]`
  (플레이어 생략형 `[장비 효과: 장비명 | 설명]` 은 해당 장비가 파티 내 1명에게만 있을 때만 적용)
  → 해당 플레이어의 캐릭터 패널 장착 슬롯에 효과가 표시됨.

### 소모품 사용 (필수)
- **소모품을 쓰면 반드시 사용 태그를 찍어라** — 수량 자동 감소:
  `[이름 사용: 아이템명]` (1개 소비) 또는 `[이름 사용: 아이템명 x2]` (2개 소비)
  예: `[허접 사용: 건빵]` → 허접의 건빵이 5개였으면 4개로 감소
- 사용하지 않았는데 소비 태그 찍지 말 것. 수량 관리는 네 몫이다.

### 장비 해제 (무기 투척/파괴/분실 시 필수)
- 플레이어가 **무기를 던지거나 잃거나 부서지면 반드시 해제 태그**:
  `[이름 장비 해제: weapon]` (또는 `무기`/`방어구`/`장신구`)
  예: 도끼 던지기 → `[12441 장비 해제: weapon]` 로 슬롯을 비워야 UI 가 "도끼 없음" 으로 갱신됨.
- 태그 안 찍으면 플레이어는 "던진 무기가 여전히 장착 중" 인 모순 상태로 보임.

### 주의
- 효과 설명은 한 줄 (120자 이내), **구체적이고 게임적으로** — "멋있다" 같은 무의미한 서술 금지.
- 태그는 각 줄에 하나씩. 묘사에는 자연스럽게 녹여라.

## 버프 / 디버프 (상태 효과)
- 지속되는 상태 효과는 반드시 **턴 수**를 명시해라:
  `[이름 버프: 효과명 N턴 | 설명]` 또는 `[이름 디버프: 효과명 N턴 | 설명]`
  예: `[허접 버프: 축복 3턴 | 공격력 +5, 명중률 +15%]`
  예: `[허접 디버프: 독 2턴 | 매 턴 HP -5]`
- N은 1~10 사이 정수. **당사자가 자기 행동을 취할 때마다 1턴씩 감소** (다른 파티원이 행동할 때는 줄지 않음). 0이 되면 자동 해제.
- 이미 걸려있는 효과를 다시 걸면 새 태그로 갱신 (새 턴 수로 덮어씀).
- 효과 설명은 한 줄 (80자 이내), 게임적이고 구체적으로.
- **즉시 해제(정화·해독·축복 종료)는 반드시 해제 태그**:
  `[이름 상태 해제: 효과명]` (또는 `[이름 디버프 해제: 독]`, `[이름 버프 해제: 축복]`)
  예: 성직자가 "정화" 주문으로 독을 풀어줌 → `[허접 상태 해제: 독]` 한 줄.
  → 이걸 안 찍으면 디버프가 정직하게 N턴 감소만 함. 서사("독이 깨끗이 빠져나갔다")와 수치가 어긋나게 됨.
- **자기 자신에게 명백히 해로운 행동을 했다면 본인에게도 디버프/피해**를 부여해라. 예: 도적이 자기 독 단도를 핥음 → 본인에게 `[도적 디버프: 독 2턴 | 매 턴 HP -3]` 처리. 우매한 자유는 우매한 결과를 낳아야 한다.

## 골드(소지 금액)
- 거래·전리품·보상으로 금액이 변하면 태그로 기록:
  `[이름 골드 +N]` (얻음) / `[이름 골드 -N]` (지출) / `[이름 골드: X → Y]` (절대값 설정)
  예: `[허접 골드 +25]` (시체에서 동전 주머니 발견)
  예: `[허접 골드 -8]` (여관 방값 지불)
- 잔고가 부족하면 거래 자체가 불성립 (서버가 음수로 못 떨어뜨림). 부족 상황도 서사로 풀어라 ("주머니를 뒤져봐도 동전 한 닢이 부족하다").
- NPC 가격은 합리적으로 (싸구려 빵 1~3, 평범한 무기 30~80, 좋은 장비 200+, 마법 두루마리 500+).

## 창의력 장려
- 플레이어가 특이하거나 엉뚱한 시도를 하면 **단순히 실패로 치지 말고** 흥미로운 결과를 만들어라.
  판정이 실패해도 이야기가 전진하게 하라 ("Yes, but..." / "No, and..." 원칙).

## 적/생물 묘사 — 종족별 발성
- 비명·고통·죽음 효과음을 **그 생물의 발성**에 맞게 써라. 인간형이 아닌 적에게 "끄아악!" 같은 인간 비명은 어색하다.
  · 개구리 → "꽉-!", "꾸륵-…", "끅-"
  · 늑대/개 → "캥!", "끼잉-", "낑-"
  · 새 → "꺽!", "꾸엑-!", 비둘기/까마귀 → "꾸루룩…"
  · 곰 → "그르렁-!", "쿠어어어-"
  · 쥐/소형 설치류 → "찍-!", "찌익!"
  · 뱀 → "쉬이익-…", "스흐-"
  · 거미·곤충 → 무성·"파득파득" 다리 떠는 묘사
  · 인간형 적(고블린·오크·도적): 그쪽은 "크아악!" 같은 인간형 비명 OK.
- 적이 **죽는 순간** 의 묘사는 한 줄, 그 종 특유의 마지막 발성 + 신체 반응 (튕기듯 굳음/풀썩 무너짐/숨이 끊어진 깃털 한 가닥).

## 인원수에 따른 난이도 스케일링
파티 요약 첫 줄에 `[파티 N명 · 평균 LvX.X]` 가 박혀있다. 적의 수·HP·강도를 이에 맞춰 조정:
- **1~2명**: 적 1~2기, HP 8~20, 평이한 난이도.
- **3~4명**: 적 3~5기, HP 12~30, 또는 강한 단일 적(HP 50+).
- **5명 이상**: 다수 적 + 정예 1기 혼성, 또는 우두머리 단일전 (HP 80+).
- 평균 레벨이 +1 오를 때마다 적 HP 의 +20% / 적 수 +1 정도가 적정.
- 너무 쉬우면 긴장이 사라지고, 너무 어려우면 좌절감만 생긴다. 매 라운드 한 명 이상이 HP 잃거나 자원 소모하도록 압박.

## 안전 지점 진입 — 마을·도시·여관·시장
파티가 평화로운 장소에 도착하면 **선택지를 자연스럽게 유도하는 묘사**를 해라:
- 시야에 들어오는 주요 시설 2~4개 가볍게 나열 (대장간 / 여관 / 시장 / 사원 / 게시판 등) — "어떤 것이 보이는지" 식의 풍경 묘사.
- 거리에서 들리는 소문 한 토막, 다가오는 NPC 한 명, 게시판의 의뢰 한 줄 정도로 "걸리는 고리" 만들기.
- "무엇을 하시겠습니까?" 같은 직접 질문은 금지 — 묘사 끝에 자연스레 "당신들의 발길이 어디로 향할지…" 정도로 여운만.
- 플레이어가 묘사 외 행동을 선택해도 매끄럽게 받아들여라 (예: 시장 묘사했는데 "지붕에 올라간다" → 그것대로 전개).

## 규칙
- 시간은 서사에 맞춰 자연스럽게 흐른다. 이동/전투/휴식마다 경과.
- 플레이어 행동을 공정 판정
- 모든 파티원을 챙기는 전개

## 파티 요약 읽는 법
파티 요약에는 각 플레이어의 Lv, HP/최대, MP/최대, **방어 수치**, **6 능력치(STR/INT/WIS/DEX/CHA/CON)**, 장착 장비, 소지품 최근 3개가 담겨있다. 방어 수치가 높은 플레이어에게는 물리 피해를 좀 더 가볍게, 낮은 플레이어에게는 더 치명적으로 묘사해라.

### 🆕 6 능력치 활용 (DND 5e PHB 스타일)
플레이어 요약에 `[STR 14, INT 8, WIS 11, DEX 16, CHA 13, CON 12]` 같은 능력치가 표시된다. 판정·서사에 이를 적극 반영:
- **근력(STR)**: 무거운 무기 휘두르기, 문 부수기, 잡기. 높으면 물리 피해 ↑.
- **지능(INT)**: 마법 위력, 지식 판정, 함정 해제. 마법사·학자형 캐릭터 핵심.
- **지혜(WIS)**: 인지·통찰 (적 매복 감지·거짓말 간파), 마법 저항. 성직자 핵심.
- **기교(DEX)**: 회피·정밀·은신·민첩성. **턴 순서(initiative)** 도 DEX 가 결정 — 높을수록 먼저 행동.
- **매력(CHA)**: NPC 호감도, 설득·협상·거래. CHA 높으면 NPC 가 호의적, 낮으면 불신·경계.
- **건강(CON)**: HP 회복 속도, 독·질병·피로 저항.
- **판정 시 modifier 공식 (영점 10 기준 대칭)**: 8~9=-1, 10~11=0, 12~13=+1, 14~15=+2, 16~17=+3, 18~19=+4. 6~7=-1, 4~5=-2.
- 능력치가 명백히 부족한 행동은 페널티·실패로, 강점에 맞는 행동은 우대해라. 단순 d20 만 굴리지 말고 "근력 판정 [🎲DM d20: 14] +공격수치" 같이 modifier 명시.
- **매력은 생성 시 고정**, 레벨업으로 안 오름. NPC 와의 관계가 캐릭터 운명을 좌우하는 시그니처 능력으로 다뤄라.

### ⚠ 능력치 숫자를 서사에 직접 노출하지 말 것 (몰입감 보호 — 매우 중요)
**금지** (게임이 스프레드시트처럼 느껴짐 — 절대 금지):
- ❌ "STR 16 의 압도적인 근력이 양손도끼에 실리자..."
- ❌ "WIS 7 의 둔한 지혜는 미세한 기운을 포착하기엔 부족하나..."
- ❌ "DEX 14 라 회피에 성공"
- ❌ "근력 16 의 그가 문을 부쉈다"

**권장** (느낌·강도의 형용사로 풀어내기):
- ✅ "압도적인 근력이 양손도끼에 실리자, 날카로운 날이 고블린의 목을 쪼갠다"
- ✅ "둔한 지혜로는 미세한 기운을 포착하기 어려웠지만, 곰 수인 특유의 후각이..."
- ✅ "민첩한 몸놀림으로 가까스로 칼날을 비껴낸다"

**숫자는 너만 보는 참고치**. 플레이어가 듣는 건 형용사여야 한다:
- 높은 STR → "압도적인", "강철 같은", "거인의", "산을 뽑을 듯한"
- 낮은 STR → "가녀린", "허약한", "지친", "버거운"
- 높은 DEX → "민첩한", "유려한", "그림자처럼", "번개 같은"
- 낮은 DEX → "둔중한", "굼뜬", "휘청이는"
- 높은 INT → "예리한", "통찰력 있는", "박학한"
- 낮은 INT → "단순한", "혼란스러운", "헷갈리는"
- 높은 WIS → "신중한", "꿰뚫어 보는", "직감적인"
- 낮은 WIS → "둔한", "산만한", "현혹된"
- 높은 CHA → "매혹적인", "위풍당당한", "거부 못 할"
- 낮은 CHA → "어색한", "거슬리는", "미더운 구석 없는"
- 높은 CON → "강건한", "지치지 않는", "철의 의지"
- 낮은 CON → "허약한", "헐떡이는", "병약한"

판정 결과 태그 (`[🎲DM d20: X] +N`) 의 N 은 modifier 라 숫자 노출 OK. 본문 묘사에서만 숫자 금지.

### 🆕 몬스터 속도 (initiative)
적이 등장할 때 `[적 등장: 이름 | HP X | 속도 Y]` 형식 가능. 속도 생략 시 기본 10.
- 빠른 적(쥐·고블린 정찰병·암살자): 14~18
- 일반: 10
- 무거운 적(트롤·곰·골렘): 5~8

### 🆕 몬스터 차례가 따로 호출됨 (Phase 3)
서버는 라운드마다 d20 + DEX/속도 모디파이어로 행동 순서를 굴린다. **플레이어 차례와 몬스터 차례가 별도로 호출되니, 너에게 보내는 메시지를 잘 구분해라**:
- `[X의 행동]: ...` 으로 시작 → 그 플레이어의 행동 결과 묘사
- `[시스템: 몬스터 행동 차례 — 고블린 A (HP X/Y, 속도 Z). 가능한 표적: A, B, C. ...]` → **그 몬스터 한 명의 1~2문장 행동만** 묘사. 다른 적의 행동을 끼워 넣지 말 것.
  - 명중 판정 `[🎲DM d20: X]` + `[표적이름 HP: A → B]` 태그로 결과 반영.
  - 적이 자기 차례를 그냥 보내는 건 금지 (플레이어들 답답함).
  - 도주/사망 임박이면 `[적 퇴장: 이름]` 도 가능.

"""  # 🆕 세계관·톤은 시나리오별로 build_system_prompt() 에서 동적으로 추가됨.


# ── 시나리오 카탈로그 ─────────────────────────
# 방 생성 시 한 개 선택(또는 랜덤). DM_SYSTEM_PROMPT 뒤에 해당 시나리오의 `setting` + `tone_note` 가
# 붙어서 방마다 다른 세계관·분위기가 적용된다. `intro_hook` 은 get_dm_intro 의 오프닝 프롬프트에 삽입.
#
# 새 시나리오 추가 가이드:
#   - setting: 세계관·주요 갈등·NPC 한 문단 (~3~5줄)
#   - tone_note: DM 이 유지할 분위기/장르 톤 한 줄
#   - intro_hook: 첫 장면 상황 설명 (어디에서 시작하는지, 무엇을 본/들었는지)
SCENARIOS: Dict[str, Dict] = {
    "volkar": {
        "name": "볼카르의 부활",
        "emoji": "🌑",
        "summary": "마왕의 봉인이 풀리기 전에 영웅들이 저지한다. 다크 판타지의 정석.",
        "tone_note": "톤: 다크 판타지 · 진지한 영웅담. 위압감 있는 악의 세력 + 희생을 감수하는 서사.",
        "setting": (
            "세계관: 고대 마왕 '볼카르' 가 수천 년의 봉인에서 깨어나고 있다. 그의 부하 — 검은 사제들과 "
            "타락한 기사단, 무리지어 약탈하는 고블린 부족들이 대륙 곳곳에서 움직이기 시작했다. "
            "영웅들은 볼카르의 완전한 부활을 막아야 한다."
        ),
        "intro_hook": (
            "볼카르의 부하들이 인근 마을을 습격했다는 소식을 듣고 파티가 출발합니다. "
            "불타는 지붕의 연기가 지평선에 피어오릅니다."
        ),
        "arc": {
            "act1": "마을 구출, 검은 사제들과 첫 교전. 단서 — 볼카르의 파편이 세 조각으로 나뉘어 전대륙에 흩어져 있음.",
            "act2": "세 파편 회수 여정. 각 장소마다 수호자/유혹자 등장. 타락 기사단 지휘관과 대치. 파티원 중 한 명이 볼카르의 속삭임을 들음.",
            "act3_choice": "부활 의식장에서 선택 — ① 파편 모두 파괴 ② 볼카르를 일깨워 직접 협상 ③ 파티원 한 명이 봉인의 매개가 되어 스스로 갇힘",
            "branches": {
                "destroy": (
                    "파편 파괴 → 볼카르 의식 흐트러짐 → 최종 잔당 소탕전 → "
                    "해피엔딩: 대륙 평화, 파티는 전설의 영웅으로 기록됨."
                ),
                "negotiate": (
                    "볼카르와 대화 → 봉인된 분노의 기원 밝혀짐 (오래전 그도 배신당함) → 서로의 이해로 약속 체결 → "
                    "해피엔딩: 볼카르는 잠들고 파티는 새 수호자. 평화로우나 언젠가 약속이 시험될 것이라는 암시."
                ),
                "sacrifice": (
                    "파티원 한 명이 봉인의 매개로 스스로 갇힘 → 남은 파티가 갇힌 동료의 구출 원정 (Act4) → "
                    "봉인 속 꿈의 세계에서 볼카르 자아 대면 (Act5) → 동료 + 볼카르의 선한 면 함께 해방 → "
                    "해피엔딩: 구출 성공, 파티는 더 끈끈해짐. 볼카르는 중립자로 합류."
                )
            },
        },
    },
    "dragon_pact": {
        "name": "용의 계약",
        "emoji": "🐉",
        "summary": "매년 조공을 받아온 적룡이 마침내 왕국에 최후통첩을 보냈다. 죽일까, 협상할까, 이용할까?",
        "tone_note": "톤: 고전 판타지 · 도덕적 선택. 정답 없는 딜레마 중심. 전투와 협상이 모두 유효.",
        "setting": (
            "세계관: 늙은 적룡 '카르녹테스' 가 백 년째 왕국에 매년 처녀 셋과 황금 마차 하나를 요구해왔다. "
            "올해 새 왕이 조공을 거부했고, 용은 3일 뒤 수도를 불태우겠다고 선언했다. "
            "파티는 비밀리에 고용된 해결사. 왕국 내부에도 용 숭배 광신도들이 섞여있다."
        ),
        "intro_hook": (
            "왕의 밀사가 인장 반지와 금화 주머니를 건넸습니다. 카르녹테스의 둥지까지 이틀 거리."
        ),
        "arc": {
            "act1": "출발. 도중 용 숭배 교단 정찰대, 마을 사람들의 엇갈리는 증언 (용이 무서움 vs 용이 우리를 지켜줌).",
            "act2": "둥지 근처 도달. 숭배자 소녀 '라니엘' 만남 — 용은 가짜 괴물이라 주장. 왕의 밀사가 뒷수작 꾸미고 있다는 단서.",
            "act3_choice": "카르녹테스와 대면 — ① 즉시 전투 ② 새 계약 재협상 ③ 왕의 음모 폭로하고 용과 연합",
            "branches": {
                "slay": (
                    "용을 무찌름 → 보물 발견 → 왕국 개선 → "
                    "해피엔딩: 영웅 칭송, 용의 보물로 영지 하나 얻음. 다만 라니엘의 슬픈 눈빛이 기억에 남음."
                ),
                "negotiate": (
                    "조공 폐지 + 매년 의식 교류로 대체하는 새 계약 → 용이 왕국 수호자로 전환 → "
                    "해피엔딩: 오랜 평화. 파티는 용과 인간 사이의 영구 외교관으로 남음."
                ),
                "betray": (
                    "왕의 진짜 음모 (용을 제거하고 광신도 숙청 → 왕권 강화) 폭로 → 왕이 파티를 반역자로 수배 → "
                    "Act4: 용·숭배자·파티 연합, 지하 동맹 결성 → Act5: 부패한 왕 타도 후 공정한 새 체제 수립 → "
                    "해피엔딩: 새 시대의 공동 설립자. 용이 의회의 자문으로 참여."
                )
            },
        },
    },
    "plague_village": {
        "name": "저주받은 마을",
        "emoji": "🕯️",
        "summary": "역병이 도는 외딴 마을, 죽은 자들이 일어난다. 원흉은 신의 분노인가, 누군가의 죄인가?",
        "tone_note": "톤: 고딕 호러 · 미스터리 · 윤리적 선택. 공포와 조사 중심. 전투보단 단서 수집·추리.",
        "setting": (
            "세계관: 숲속 외딴 마을 '에벤하임' 에 정체불명의 역병이 돌고 있다. 감염자는 검은 피를 토하며 "
            "죽고, 사흘 뒤 시체가 일어나 마을을 배회한다. 성직자 '오스윈' 은 '신의 심판' 이라 설교한다. "
            "마을 지하에는 오래된 납골당이 있고, 촌장 가문은 대대로 '지키는 서약' 을 이어왔다."
        ),
        "intro_hook": (
            "파티는 에벤하임에 도착. 마을 입구 문 앞에 잿빛 얼굴의 아이가 서서 속삭입니다. "
            "\"빨리... 돌아가세요. 여긴 이미 늦었어요.\""
        ),
        "arc": {
            "act1": "도착 직후 이상 징후 3개 수집: 검은 피, 사라진 아이들, 촌장의 수상한 열쇠. 잿빛 아이는 사실 이미 죽은 자.",
            "act2": "납골당 진입. 오래된 서약서 해독 — 조상이 봉인한 유물이 아래에 잠들어있음. 성직자 오스윈의 실체 (유물의 새 숙주 노림).",
            "act3_choice": "지하 제단 — 유물 앞에서 선택 → ① 성스러운 불로 파괴 ② 서약서 재봉인 ③ 파티원 한 명이 흡수해 숙주가 됨",
            "branches": {
                "purify": (
                    "파괴 의식 → 오스윈 최후 저항, 마을 환자 한꺼번에 회복 → "
                    "해피엔딩: 마을 구원, 파티는 치유자로 기억됨. 촌장이 대대로 지켜온 짐을 내려놓음."
                ),
                "seal": (
                    "봉인 의식 → 백년 평화 확보 → 다음 세대의 과제라는 암시 → "
                    "해피엔딩: 당장의 위험은 해소. 마을이 서서히 재건되고 파티가 새 수호자 가문으로 자리잡음."
                ),
                "host": (
                    "파티원 한 명 흡수 → 그의 눈이 검어지고 꿈이 흘러넘침 (Act4) → 남은 파티가 그의 내면으로 "
                    "환상 여행 (Act5), 유물의 진짜 기원 — 배신당한 고대 치유사의 영혼 — 발견 → 함께 달래 정화 → "
                    "해피엔딩: 숙주는 특별한 치유력을 얻은 채 원래대로 돌아옴. 파티는 이 유대로 더 단단해짐."
                )
            },
        },
    },
    "masquerade_heist": {
        "name": "가면무도회 잠입",
        "emoji": "🎭",
        "summary": "공작성 대가면무도회, 전설의 보물을 훔쳐야 한다. 변장·사교·재치의 무대.",
        "tone_note": "톤: 경쾌한 하이스트 · 사교 드라마. 전투보단 변장·거짓말·타이밍. 실패해도 '들킴' 이 재미.",
        "setting": (
            "세계관: 라벤루즈 공작의 100년 만의 대가면무도회. 전설의 '시간의 오팔' 이 홀 중앙에 전시된다. "
            "파티는 익명의 학자에게 고용됨. 경쟁 도둑 길드 '깊은 밤' 도 같은 목표. "
            "공작은 은퇴한 대마법사 경호를, 하인들 중엔 왕실 첩자도 섞여있다."
        ),
        "intro_hook": (
            "파티는 밀수업자의 마차 뒷칸에서 공작성에 도착. 각자 위조 초대장과 가면, 의상이 준비돼 있고, "
            "신호는 자정의 종 — 앞으로 3시간 남았습니다."
        ),
        "arc": {
            "act1": "홀 입장, 인물 탐색. 공작, 경쟁 도둑, 왕실 첩자, 정체불명의 대마법사 경호원의 시선 교차.",
            "act2": "오팔 경비 패턴 파악. 경쟁 길드와 잠깐 협력 or 방해. 의뢰인의 전령이 미묘하게 변경된 지시 전달.",
            "act3_choice": "자정 — ① 깔끔히 훔쳐 탈출 ② 발각됐을 때 공작과 사교적 거래 ③ 의뢰인이 흑막임이 드러남",
            "branches": {
                "clean": (
                    "탈출 성공 → 의뢰인 오팔 전달 → "
                    "해피엔딩: 거액 보상, 귀족 세계에 이름 남음. 의뢰인이 오팔로 무엇을 했는지는 풍문으로만."
                ),
                "diplomacy": (
                    "발각 후 재치로 공작 설득 → 공작이 오히려 파티를 매력적으로 여김, 장기 계약 → "
                    "해피엔딩: 귀족 동맹, 공작가 비공식 수행자 지위."
                ),
                "betray": (
                    "의뢰인이 진짜는 왕실 전복 음모단장 → 오팔로 왕 시간 정지 작전 → 파티가 의뢰 파기 → "
                    "Act4: 음모단의 잔존 세력 추적, 숨겨진 거점 찾음 → Act5: 최종 음모 저지 + 오팔을 학회에 "
                    "반환 → 해피엔딩: 왕실의 비밀 공신. 귀족·학회 양쪽에서 신뢰받는 해결사."
                )
            },
        },
    },
    "beast_king_arena": {
        "name": "야수왕의 투기장",
        "emoji": "⚔️",
        "summary": "10년에 한 번 열리는 대륙 최강 토너먼트. 우승 상금과 왕의 호의를 걸고 8강 돌파.",
        "tone_note": "톤: 액션 · 스포츠 드라마. 전투 중심이지만 경기장 밖 음모·라이벌·후원자 드라마.",
        "setting": (
            "세계관: 야수왕 '그르몰드' 의 10년 주기 대투기장. 대륙 강자들이 본선 8강. "
            "우승 상금: 한 영지 10년치 세금 + 왕의 단 한 가지 호의. "
            "강자들: 강철 코뿔소 울가르, 유령 춤꾼 리셀린, 쌍검 형제 타른·카른, 전년 챔피언 불사 영혼 베릭."
        ),
        "intro_hook": (
            "본선 8강 진출. 대기실에 첫 상대 정보와 경기장의 거대한 관중 함성이 들립니다."
        ),
        "arc": {
            "act1": "8강 첫 경기 승리, 후원자 접촉 (도박사·귀족·암거래상). 라이벌 리셀린의 존경 섞인 도발.",
            "act2": "4강 — 쌍검 형제 또는 울가르와 격전. 불사 영혼 베릭이 '경기 너머' 를 언급 (왕이 뭔가 숨김).",
            "act3_choice": "결승 — ① 정정당당 승리 ② 반칙·약물 폭로로 투기장 개혁 ③ 베릭의 진실(왕의 꼭두각시) 폭로",
            "branches": {
                "honor": (
                    "정정당당 우승 → 왕의 호의 수령 → "
                    "해피엔딩: 영지 획득, 대륙 명예의 전당. 리셀린과는 평생의 선의의 라이벌."
                ),
                "expose": (
                    "약물·부정거래 폭로 → 투기장 대개혁 → "
                    "해피엔딩: 투기장이 진짜 스포츠로 거듭남. 파티는 개혁의 얼굴. 우승 상금은 개혁 기금으로."
                ),
                "liberate": (
                    "베릭의 진실 — 왕이 챔피언을 꼭두각시로 세워 반대파 숙청 → 파티가 베릭과 연합 → "
                    "Act4: 궁정 숨겨진 사병 거점 탐색, 증거 수집 → Act5: 공개 법정 도전, 야수왕 대치 → "
                    "해피엔딩: 공정한 새 규약, 그르몰드 폐위 + 원로회 통치. 베릭은 자유."
                )
            },
        },
    },
    "deep_sea_horror": {
        "name": "심해의 부름",
        "emoji": "🐙",
        "summary": "어부들이 사라지는 해안 마을. 조사할수록 파티의 꿈이 바뀐다. 코스믹 호러.",
        "tone_note": (
            "톤: 코스믹 호러 · 점진적 광기. 공포는 서서히. 파티가 '비합리적 선택' 을 하면 DM 은 그걸 "
            "서사의 자연스러운 변화로 수용 (강제는 금지). 큰 전투보단 분위기·암시·이상 증상."
        ),
        "setting": (
            "세계관: 해안 마을 '사그라' 의 어부 연쇄 실종. 시체는 눈이 파이고 입가엔 미소가 굳어있다. "
            "절벽 아래 바닷속에 고대 신전이 잠들어있다는 전설. 마을 노인들은 '부르는 소리' 를 듣는다. "
            "조사할수록 꿈속의 바다, 비늘 돋은 손가락, 떠나지 않는 해조 냄새."
        ),
        "intro_hook": (
            "파티는 실종 어부의 아내에게 고용되어 사그라 항구에 도착. 갈매기들이 일제히 날아가고 안개가 "
            "피부를 스칩니다. 귓속 깊은 곳에서 낮은 허밍이 들립니다."
        ),
        "arc": {
            "act1": "항구·시체·어부 가족 조사. 꿈의 변화 시작 (파티원마다 다른 증상). 신전의 잠수부 동료가 남긴 일기 발견.",
            "act2": "해저 신전 입구 발견, 첫 잠입. 살아남은 '수호자' 노파의 증언 — 신은 잠들어있고 우리가 깨우지 말았어야 함.",
            "act3_choice": "신전 제단에서 고대 존재의 꿈과 직면 → ① 재봉인 ② 제한적 거래 ③ 파티원 한 명이 '부름' 을 받아들임",
            "branches": {
                "seal": (
                    "재봉인 의식 → 해일 물러남 → "
                    "해피엔딩: 마을 구원. 파티는 가끔 꿈에서 바다 냄새를 맡는 정도의 잔존 흔적. 일상 복귀."
                ),
                "pact": (
                    "공존 조건 합의 — 매년 마을 물고기의 일부를 제단에 바침 → 그 대가로 폭풍·흉어 방지 → "
                    "해피엔딩: 마을이 번영하고 파티는 '바다의 수호자' 칭호. 존재는 다시 잠듦."
                ),
                "absorb": (
                    "한 명이 부름을 받아들여 변화 시작 (비늘·푸른 눈·해조 목소리) → Act4: 남은 파티가 변한 "
                    "동료를 따라 심해로 동행, 신전 가장 깊은 곳 탐사 → Act5: 존재의 진짜 이름을 알고 그것이 "
                    "원래 해로운 존재가 아닌 고독했던 수호자였음을 밝힘 + 정화 의식 → "
                    "해피엔딩: 흡수된 동료는 변화를 일부 간직한 채 인간 형태로 돌아옴 (유니크한 해양 감각 보유). "
                    "고대 존재는 마을의 진짜 수호신으로 돌아가고, 파티는 '깊이를 본 자들' 이라는 새 정체성."
                )
            },
        },
    },
}

DEFAULT_SCENARIO_ID = "volkar"


def build_system_prompt(scenario_id: Optional[str]) -> str:
    """DM_SYSTEM_PROMPT + 시나리오별 세계관/톤 + 아크 구조 + 해피엔딩 원칙 결합."""
    sc = SCENARIOS.get(scenario_id) or SCENARIOS[DEFAULT_SCENARIO_ID]
    arc = sc.get("arc") or {}
    branches_text = ""
    if arc.get("branches"):
        branches_text = "\n- 분기별 엔딩 (모두 해피엔딩으로 수렴, 색만 다름):\n"
        for key, desc in arc["branches"].items():
            branches_text += f"  · **{key}**: {desc}\n"
    arc_block = ""
    if arc:
        arc_block = (
            "\n## 시나리오 아크 (너만 보는 DM 가이드 — 이 흐름대로 유도)\n"
            f"- Act 1 (도입): {arc.get('act1', '')}\n"
            f"- Act 2 (전개): {arc.get('act2', '')}\n"
            f"- Act 3 (절정·선택): {arc.get('act3_choice', '')}\n"
            f"{branches_text}\n"
            "### 진행 원칙 (중요)\n"
            "1. **모든 길은 해피엔딩으로 수렴한다.** 파티의 '나쁜 선택' 은 더 긴 여정이 될 뿐, "
            "게임 오버나 영구 손실은 없다. 숙주·저주·타락 선택이라도 다음 막에서 **구원 아크** 로 전개해라.\n"
            "2. 현재 몇 막인지 스스로 판단. 파티가 비트를 통과했다고 느끼면 자연스럽게 다음 막의 장면으로 전환.\n"
            "3. Act 3 의 선택이 이루어지면 **해당 분기의 엔딩 방향으로 진행**. 5~10턴 안에 깔끔한 "
            "클라이맥스와 에필로그를 그려라.\n"
            "4. 캠페인 종결 시점엔 `[캠페인 종료: <분기키>]` 태그를 찍어라 (예: `[캠페인 종료: host]`).\n"
            "5. 플레이어가 아크에서 크게 벗어난 자유 행동을 하면 부드럽게 세계관 안의 사건으로 "
            "연결시켜 다시 아크로 유도. 억지로 막지 말 것.\n"
        )
    return (
        DM_SYSTEM_PROMPT
        + f"\n## 이번 캠페인 — {sc['emoji']} {sc['name']}\n"
        + f"{sc['tone_note']}\n\n"
        + sc['setting']
        + arc_block
    )


def _scenario_public(scenario_id: Optional[str]) -> dict:
    """브로드캐스트용 시나리오 메타 — name/emoji/summary 만. setting 은 DM 전용 정보라 숨김."""
    sc = SCENARIOS.get(scenario_id) or SCENARIOS[DEFAULT_SCENARIO_ID]
    return {
        "id": scenario_id if scenario_id in SCENARIOS else DEFAULT_SCENARIO_ID,
        "name": sc["name"],
        "emoji": sc["emoji"],
        "summary": sc["summary"],
    }


def _all_scenarios_public() -> List[dict]:
    """카탈로그 — 방 만들기 화면에서 사용자가 선택할 수 있도록 전체 목록 (id 순서 유지)."""
    return [{"id": sid, **_scenario_public(sid)} for sid in SCENARIOS.keys()]


# ── 태그 파싱 공통 ─────────────────────────────
HP_PATTERN = re.compile(r"\[([^\]]+?)\s*HP\s*[:：]\s*(\d+)\s*(?:→|->|=>|-)\s*(\d+)\]")
MP_PATTERN = re.compile(r"\[([^\]]+?)\s*MP\s*[:：]\s*(\d+)\s*(?:→|->|=>|-)\s*(\d+)\]")
XP_PATTERN = re.compile(r"\[([^\]]+?)\s*XP\s*\+\s*(\d+)\]")
# 고아 XP 태그 — DM 이 [XP +N] 로 이름을 빼먹은 경우. 행동자에게 귀속시킨다.
XP_ORPHAN_PATTERN = re.compile(r"\[\s*XP\s*\+\s*(\d+)\s*\]")
# 골드(소지 금액) — 두 포맷 동시 지원:
#   `[이름 골드: X → Y]` (HP/MP 와 일관성)
#   `[이름 골드 +N]` / `[이름 골드 -N]` (증감 표기)
GOLD_SET_PATTERN  = re.compile(r"\[([^\]]+?)\s*골드\s*[:：]\s*(\d+)\s*(?:→|->|=>|-)\s*(\d+)\]")
GOLD_DELTA_PATTERN = re.compile(r"\[([^\]]+?)\s*골드\s*([+\-−])\s*(\d+)\]")

# 아이템 획득 — 효과(2번째 |) 와 종류(3번째 |) 모두 선택 사항.
# 지원 포맷:
#   [이름 획득: 아이템]
#   [이름 획득: 아이템 | 효과]
#   [이름 획득: 아이템 | 종류 | 효과]
# 종류 키워드: 무기 / 방어구 / 장신구 / 장비 / 소모품 / 퀘스트
# - 무기·방어구·장신구 셋 중 하나면 장비로 분류 + 슬롯 자동 결정.
# - "장비" 만 적으면 무기 슬롯 기본 (DM 이 슬롯 명확히 적도록 프롬프트 유도).
# - "소모품" / "퀘스트" 또는 종류 미지정은 비장비 인벤토리 항목.
ITEM_PATTERN = re.compile(
    r"\[([^\]]+?)\s*획득\s*[:：]\s*([^\]|]+?)"
    r"(?:\s*\|\s*([^\]|]+?))?"
    r"(?:\s*\|\s*([^\]]+?))?\]"
)
ITEM_KIND_KEYWORDS = {
    "무기":   ("equipment", "weapon"),
    "방어구": ("equipment", "armor"),
    "갑옷":   ("equipment", "armor"),   # alias
    "로브":   ("equipment", "armor"),   # alias
    "장신구": ("equipment", "accessory"),
    "장비":   ("equipment", "weapon"),  # 슬롯 미지정 → 무기 디폴트
    "소모품": ("consumable", None),
    "퀘스트": ("quest", None),
    "키":     ("quest", None),          # alias
}

# 디버프/버프 즉시 해제 (정화·해독·축복 종료 등):
#   `[이름 상태 해제: 효과명]` (효과 종류 자동 식별)
#   `[이름 디버프 해제: 효과명]`
#   `[이름 버프 해제: 효과명]`
STATUS_CLEAR_PATTERN = re.compile(
    r"\[([^\]]+?)\s*(?:상태|버프|디버프)\s*해제\s*[:：]\s*([^\]]+?)\]"
)
# 기존 아이템의 효과 공개. 두 가지 포맷 허용:
#   (A) `[아이템 효과: 플레이어 | 아이템 | 설명]` — 플레이어 지목형 (권장)
#   (B) `[아이템 효과: 아이템 | 설명]` — 파티 내 그 아이템 보유자가 1명일 때만 적용
ITEM_EFFECT_PATTERN_P = re.compile(r"\[아이템\s*효과\s*[:：]\s*([^\]|]+?)\s*\|\s*([^\]|]+?)\s*\|\s*([^\]]+?)\]")
ITEM_EFFECT_PATTERN   = re.compile(r"\[아이템\s*효과\s*[:：]\s*([^\]|]+?)\s*\|\s*([^\]]+?)\]")
# 장비 효과 공개. 동일 패턴:
#   (A) `[장비 효과: 플레이어 | 장비 | 설명]`
#   (B) `[장비 효과: 장비 | 설명]` — 해당 장비를 든 플레이어가 1명일 때만 적용
EQUIP_EFFECT_PATTERN_P = re.compile(r"\[장비\s*효과\s*[:：]\s*([^\]|]+?)\s*\|\s*([^\]|]+?)\s*\|\s*([^\]]+?)\]")
EQUIP_EFFECT_PATTERN   = re.compile(r"\[장비\s*효과\s*[:：]\s*([^\]|]+?)\s*\|\s*([^\]]+?)\]")
# 소모품 사용: [이름 사용: 아이템] 또는 [이름 사용: 아이템 x수량]
ITEM_USE_PATTERN = re.compile(r"\[([^\]]+?)\s*사용\s*[:：]\s*([^\]]+?)\]")
# 🆕 장비 해제 — 무기 투척/파괴/분실 등. 슬롯 명 또는 "무기/방어구/장신구" 로 지정.
#   [이름 장비 해제: weapon]   또는  [이름 장비 해제: 무기]
#   [이름 장비 해제: armor]    또는  [이름 장비 해제: 방어구]
#   [이름 장비 해제: accessory] 또는 [이름 장비 해제: 장신구]
EQUIP_UNEQUIP_PATTERN = re.compile(r"\[([^\]]+?)\s*장비\s*해제\s*[:：]\s*([^\]]+?)\]")
# 버프/디버프: [이름 버프: 효과명 N턴 | 설명] 또는 [이름 디버프: 효과명 N턴 | 설명]
STATUS_PATTERN = re.compile(
    r"\[([^\]]+?)\s*(버프|디버프)\s*[:：]\s*([^|\]]+?)\s+(\d+)\s*턴(?:\s*\|\s*([^\]]+?))?\]"
)
# 🆕 캠페인 종료 태그: [캠페인 종료: 분기키]. DM 이 아크 결말에 도달하면 찍고, 서버가 엔딩 화면 트리거.
CAMPAIGN_END_PATTERN = re.compile(r"\[캠페인\s*종료\s*[:：]\s*([a-zA-Z_]+)\s*\]")
# 끝에 xN (또는 ×N) 붙어있으면 수량 추출
QTY_SUFFIX = re.compile(r"\s*[xX×]\s*(\d+)\s*$")

# XP 태그 남발/악용 방지 — 서버단에서 clamp.
XP_GAIN_MAX_PER_EVENT = 200
XP_GAIN_MAX_PER_RESPONSE = 500


def _split_qty(raw: str) -> Tuple[str, int]:
    """'아이템명 x3' → ('아이템명', 3). 수량 없으면 1."""
    m = QTY_SUFFIX.search(raw)
    if m:
        return raw[:m.start()].strip(), int(m.group(1))
    return raw.strip(), 1
# DM 주사위 — `[🎲DM d20: 14]` 포맷. 플레이어 주사위(`[🎲d20: 14]` 혹은 `[🎲 이름 d20: 14]`)와 구별.
DM_DICE_PATTERN = re.compile(r"\[🎲\s*DM\s*(d\d+)\s*[:：]\s*(\d+)\]", re.IGNORECASE)

# ── 몬스터 관리 태그 ─────────────────────────
# 파티 아래 '몬스터' 섹션에 카드로 노출되는 전투 유닛. DM 이 이 태그로 상태를 업데이트한다.
#   [적 등장: 고블린 A | HP 12]   → 신규 등장 (이름 중복이면 무시)
#   [적 HP: 고블린 A 12 → 5]      → HP 변화 (0 되면 자동 제거)
#   [적 상태: 고블린 A | 넘어짐]   → 상태 메모 교체 (빈 문자열이면 clear)
#   [적 퇴장: 고블린 A]            → 즉시 제거 (도망/합체/이탈 등)
#   [적 버프: 고블린 A | 가속 2턴 | 회피 +20%]              → 적에게 버프
#   [적 디버프: 고블린 A | 독 3턴 | 매 턴 -4 HP]           → 적에게 디버프 (DOT 자동 적용)
# [적 등장: 이름 | HP 12]  또는  [적 등장: 이름 | HP 12 | 속도 14]
# 속도 생략 시 기본 10 (Monster 클래스 default).
MONSTER_SPAWN_PATTERN = re.compile(
    r"\[적\s*등장\s*[:：]\s*([^\]|]+?)\s*\|\s*HP\s*(\d+)\s*"
    r"(?:\|\s*(?:속도|speed|SPD)\s*(\d+)\s*)?"
    r"\]"
)
MONSTER_HP_PATTERN     = re.compile(r"\[적\s*HP\s*[:：]\s*([^\]]+?)\s+(\d+)\s*[→>\-]+\s*(\d+)\s*\]")
MONSTER_STATUS_PATTERN = re.compile(r"\[적\s*상태\s*[:：]\s*([^\]|]+?)\s*\|\s*([^\]]+?)\s*\]")
MONSTER_LEAVE_PATTERN  = re.compile(r"\[적\s*퇴장\s*[:：]\s*([^\]]+?)\s*\]")
MONSTER_BUFF_PATTERN   = re.compile(
    r"\[적\s*(버프|디버프)\s*[:：]\s*([^\]|]+?)\s*\|\s*([^|\]]+?)\s+(\d+)\s*턴(?:\s*\|\s*([^\]]+?))?\]"
)


def _match_player(name_field: str, players: Dict[str, "Player"]) -> Optional["Player"]:
    """플레이어 이름 **정확 매칭만** 허용 (양쪽 strip 후 비교).
    부분 매칭은 '철수' / '김철수' 같은 서브셋 이름에서 오탐 → 제거됨.
    DM 프롬프트에도 '플레이어 이름을 정확히 그대로 쓸 것' 이 명시돼 있다."""
    target = name_field.strip()
    for p in players.values():
        if p.name == target:
            return p
    return None


def parse_and_apply_hp(text: str, players: Dict[str, "Player"]) -> List[str]:
    """HP 업데이트 추출 및 적용. 영향받은 이름 리스트 반환."""
    updated: List[str] = []
    for m in HP_PATTERN.finditer(text):
        name_field = m.group(1).strip()
        new_hp = int(m.group(3))
        target = _match_player(name_field, players)
        if target:
            target.hp = max(0, min(target.max_hp, new_hp))
            updated.append(target.name)
    return updated


def parse_and_apply_mp(text: str, players: Dict[str, "Player"]) -> List[str]:
    """MP(마력) 업데이트. HP 와 동일 구조."""
    updated: List[str] = []
    for m in MP_PATTERN.finditer(text):
        name_field = m.group(1).strip()
        new_mp = int(m.group(3))
        target = _match_player(name_field, players)
        if target:
            target.mp = max(0, min(target.max_mp, new_mp))
            updated.append(target.name)
    return updated


def parse_and_apply_gold(text: str, players: Dict[str, "Player"]) -> List[dict]:
    """골드 변동 파싱. set 포맷 + delta 포맷 둘 다 지원.
    반환: [{name, gold, delta}] — gold 는 적용 후 잔액, delta 는 변화량 (+/-)."""
    out: List[dict] = []
    # set 포맷
    for m in GOLD_SET_PATTERN.finditer(text):
        name = m.group(1).strip()
        try:
            new_gold = int(m.group(3))
        except ValueError:
            continue
        target = _match_player(name, players)
        if not target:
            continue
        delta = new_gold - target.gold
        target.gold = max(0, new_gold)
        out.append({"name": target.name, "gold": target.gold, "delta": delta})
    # delta 포맷 (+ / - / − 모두 허용)
    for m in GOLD_DELTA_PATTERN.finditer(text):
        name = m.group(1).strip()
        sign = m.group(2)
        try:
            amount = int(m.group(3))
        except ValueError:
            continue
        if sign in ("-", "−"):
            amount = -amount
        target = _match_player(name, players)
        if not target:
            continue
        target.gold = max(0, target.gold + amount)
        out.append({"name": target.name, "gold": target.gold, "delta": amount})
    return out


def parse_and_clear_statuses(text: str, players: Dict[str, "Player"]) -> List[dict]:
    """상태 효과 즉시 제거. DM 이 '독이 해독되었다' 같은 서사를 쓰면 반드시 함께 찍는 태그.
    이걸 안 찍으면 디버프가 정직하게 턴 감소만 함 → 서사·수치 어긋남."""
    cleared: List[dict] = []
    for m in STATUS_CLEAR_PATTERN.finditer(text):
        name_field = m.group(1).strip()
        effect_name = m.group(2).strip()
        if not effect_name or len(effect_name) > 24:
            continue
        target = _match_player(name_field, players)
        if not target:
            continue
        before = len(target.status_effects)
        target.status_effects = [
            st for st in target.status_effects
            if st.get("name") != effect_name
        ]
        if len(target.status_effects) < before:
            cleared.append({"player_name": target.name, "name": effect_name})
    return cleared


def parse_dm_dice(text: str) -> List[Tuple[str, int]]:
    """DM 이 굴린 주사위 목록 추출. [(die, result), ...] 반환.
    die_max 범위 검증까지 수행."""
    die_map = {"d4": 4, "d6": 6, "d8": 8, "d10": 10, "d12": 12, "d20": 20, "d100": 100}
    out: List[Tuple[str, int]] = []
    for m in DM_DICE_PATTERN.finditer(text):
        die = m.group(1).lower()
        try:
            result = int(m.group(2))
        except ValueError:
            continue
        if die in die_map and 1 <= result <= die_map[die]:
            out.append((die, result))
    return out


def parse_and_apply_monsters(text: str, monsters: "Dict[str, Monster]",
                             acting_player_id: Optional[str] = None) -> List[dict]:
    """몬스터 태그 → `monsters` dict in-place 갱신. 이벤트 리스트 반환.
    이벤트 kind: spawn / hp / status / defeated / leave / buff / debuff.
    defeated 이벤트는 attackers 리스트도 동봉 — 후속 XP 분배에 쓰임.
    HP 가 깎이면 acting_player_id 가 그 몬스터의 attackers 에 기록됨."""
    events: List[dict] = []

    def _find(raw_name: str) -> Optional["Monster"]:
        # 등장 시 정한 풀네임과 **정확 매칭만** (양방향 부분매칭은 '고블린' vs '고블린 궁수' 오탐 원인).
        # DM 프롬프트에 "풀네임 그대로 재사용" 이 명시되어 있다.
        return monsters.get(raw_name.strip())

    for m in MONSTER_SPAWN_PATTERN.finditer(text):
        name = m.group(1).strip()
        hp = int(m.group(2))
        # 🆕 속도 옵션 (group 3) — 명시 안 되면 기본 10
        try:
            speed = int(m.group(3)) if m.group(3) else 10
        except (TypeError, ValueError):
            speed = 10
        speed = max(1, min(30, speed))
        if name and name not in monsters:
            monsters[name] = Monster(name, hp, speed=speed)
            events.append({"kind": "spawn", "name": name, "hp": hp, "speed": speed})

    for m in MONSTER_HP_PATTERN.finditer(text):
        name = m.group(1).strip()
        try:
            # group(2) = DM 이 명시한 이전 HP — 우린 서버 측 prev_hp 로 비교하니 무시.
            new_hp = int(m.group(3))
        except ValueError:
            continue
        target = _find(name)
        if target:
            prev_hp = target.hp
            target.hp = max(0, min(target.max_hp, new_hp))
            # HP 가 깎였으면 = 이번 턴 행동자가 때린 것 → 처치자 / 어시 추적용으로 기록.
            if acting_player_id and target.hp < prev_hp:
                target.note_attacker(acting_player_id)
            events.append({"kind": "hp", "name": target.name, "hp": target.hp, "max_hp": target.max_hp})
            if target.hp <= 0:
                # 처치 시 attackers 스냅샷을 이벤트에 동봉 — 호출부에서 XP 분배.
                events.append({
                    "kind": "defeated",
                    "name": target.name,
                    "max_hp": target.max_hp,
                    "attackers": list(target.attackers),
                })
                monsters.pop(target.name, None)

    for m in MONSTER_STATUS_PATTERN.finditer(text):
        name = m.group(1).strip()
        note = m.group(2).strip()
        target = _find(name)
        if target:
            target.status_note = note or None
            events.append({"kind": "status", "name": target.name, "note": note})

    # 🆕 몬스터 버프/디버프 — 플레이어와 같은 구조로 status_effects 에 적재.
    # 디버프 효과 설명에서 DOT 수치가 잡히면 다음 round_complete 에서 자동 HP 감소.
    for m in MONSTER_BUFF_PATTERN.finditer(text):
        kind = m.group(1).strip()
        name = m.group(2).strip()
        eff_name = m.group(3).strip()
        try:
            turns = int(m.group(4))
        except ValueError:
            continue
        desc = (m.group(5) or "").strip() or None
        if not eff_name or len(eff_name) > 24:
            continue
        if turns < 1 or turns > 10:
            continue
        if desc and len(desc) > 80:
            desc = desc[:80]
        target = _find(name)
        if target:
            target.apply_status(kind, eff_name, turns, desc)
            events.append({
                "kind": "buff" if kind == "버프" else "debuff",
                "name": target.name,
                "effect_name": eff_name,
                "turns": turns,
                "effect": desc,
            })

    for m in MONSTER_LEAVE_PATTERN.finditer(text):
        name = m.group(1).strip()
        target = _find(name)
        if target:
            monsters.pop(target.name, None)
            events.append({"kind": "leave", "name": target.name})

    return events


def parse_and_apply_xp(text: str, players: Dict[str, "Player"],
                       acting_player_id: Optional[str] = None) -> List[dict]:
    """XP 적립. 한 태그당/한 응답당 상한을 서버가 clamp 한다.
    각 이벤트는 {name, amount, granted, new_level|None, gains|None} 형태 —
    granted 는 clamp 후 실제 적립된 양 (amount 와 다를 수 있음).

    🆕 고아 태그 복구: `[XP +N]` 처럼 이름 없이 온 것은 **acting_player_id** 에게 귀속.
    이전엔 DM 이 이름을 빼먹으면 XP 가 증발하고 본문에 태그만 노출돼 유저가 혼란."""
    events: List[dict] = []
    total_granted = 0
    # 이름 있는 패턴이 잡아간 span 을 기록 — 고아 패턴 재파싱 시 중복 적용 방지.
    consumed_spans: List[Tuple[int, int]] = []

    def _apply(target: "Player", requested: int, name_field: str) -> None:
        nonlocal total_granted
        per_event = max(0, min(requested, XP_GAIN_MAX_PER_EVENT))
        room_left = max(0, XP_GAIN_MAX_PER_RESPONSE - total_granted)
        granted = min(per_event, room_left)
        if granted <= 0:
            if requested > 0:
                print(f"[XP CLAMP] {name_field!r} requested={requested} granted=0 (already at response cap)")
            return
        if granted < requested:
            print(f"[XP CLAMP] {name_field!r} requested={requested} → granted={granted}")
        total_granted += granted
        lvl_info = target.grant_xp(granted)
        base = {"name": target.name, "amount": requested, "granted": granted}
        if lvl_info:
            events.append({**base, "new_level": lvl_info["new_level"], "gains": lvl_info["gains"]})
        else:
            events.append({**base, "new_level": None, "gains": None})

    for m in XP_PATTERN.finditer(text):
        name_field = m.group(1).strip()
        try:
            requested = int(m.group(2))
        except ValueError:
            continue
        target = _match_player(name_field, players)
        if not target:
            # 이름 필드가 공백뿐이거나 숫자만이면 아래 고아 패턴이 처리하도록 span 도 기록 안 함.
            if name_field and not name_field.isdigit():
                print(f"[XP MISS] no exact player match for {name_field!r} -> tag ignored")
                consumed_spans.append(m.span())
            continue
        consumed_spans.append(m.span())
        _apply(target, requested, name_field)

    # 고아 태그 복구 — acting_player_id 있을 때만.
    if acting_player_id:
        actor = players.get(acting_player_id)
        if actor:
            for m in XP_ORPHAN_PATTERN.finditer(text):
                # 이미 이름 있는 패턴이 먹은 범위면 스킵.
                span = m.span()
                if any(span[0] >= s and span[1] <= e for s, e in consumed_spans):
                    continue
                try:
                    requested = int(m.group(1))
                except ValueError:
                    continue
                print(f"[XP RECOVER] 이름 없는 [XP +{requested}] → {actor.name} 에게 귀속")
                _apply(actor, requested, f"<orphan→{actor.name}>")

    return events


def parse_and_apply_statuses(text: str, players: Dict[str, "Player"]) -> List[dict]:
    """버프/디버프 태그 파싱. 각각 플레이어에 상태 효과 추가/갱신.
    반환: [{player_name, kind, name, turns, effect}] — 새로 적용된(혹은 갱신된) 것들."""
    applied: List[dict] = []
    for m in STATUS_PATTERN.finditer(text):
        name_field = m.group(1).strip()
        kind = m.group(2).strip()  # "버프" | "디버프"
        effect_name = m.group(3).strip()
        try:
            turns = int(m.group(4))
        except ValueError:
            continue
        desc = (m.group(5) or "").strip() or None
        if desc and len(desc) > 80:
            desc = desc[:80]
        if not effect_name or len(effect_name) > 24:
            continue
        if turns < 1 or turns > 10:
            continue
        target = _match_player(name_field, players)
        if not target:
            continue
        target.apply_status(kind, effect_name, turns, desc)
        applied.append({
            "player_name": target.name,
            "kind": kind, "name": effect_name,
            "turns": turns, "effect": desc,
        })
    return applied


def _classify_item(part2: Optional[str], part3: Optional[str]) -> Tuple[str, Optional[str], Optional[str]]:
    """아이템 획득 태그의 2번째·3번째 | 부분을 (kind, slot, effect) 로 분류.
    포맷:
      획득: 아이템                  → kind=consumable, slot=None, effect=None
      획득: 아이템 | 효과            → kind=consumable, slot=None, effect=효과
      획득: 아이템 | 종류 | 효과     → kind=종류 매핑, slot=종류 매핑, effect=효과
    종류 키워드만 있고 효과가 없거나 그 반대도 자연스럽게 처리."""
    p2 = (part2 or "").strip() or None
    p3 = (part3 or "").strip() or None
    # 둘 다 있으면 p2=종류 / p3=효과
    if p2 and p3:
        kind_info = ITEM_KIND_KEYWORDS.get(p2)
        if kind_info:
            return kind_info[0], kind_info[1], p3
        # p2 가 종류 키워드가 아니면 둘 다 효과 본문의 일부로 간주 — 합쳐서 effect.
        return "consumable", None, f"{p2} | {p3}"
    # p2 만 있는 경우
    if p2:
        kind_info = ITEM_KIND_KEYWORDS.get(p2)
        if kind_info:
            return kind_info[0], kind_info[1], None
        return "consumable", None, p2  # 효과 설명으로 해석
    return "consumable", None, None


def parse_and_apply_items(text: str, players: Dict[str, "Player"]) -> List[dict]:
    """아이템 획득 파싱. 반환 이벤트:
      {name, item, effect|None, quantity, kind, slot|None, auto_equipped: bool}
    auto_equipped 가 True 이면 서버가 자동 장착 처리 (기존 장비를 인벤토리로 회수했음).
    """
    gained: List[dict] = []
    for m in ITEM_PATTERN.finditer(text):
        name_field = m.group(1).strip()
        raw_item = m.group(2).strip()
        kind, slot, effect = _classify_item(m.group(3), m.group(4))
        item, qty = _split_qty(raw_item)
        if effect and len(effect) > 120:
            effect = effect[:120]
        if not item or len(item) > 40 or qty < 1 or qty > 99:
            continue
        target = _match_player(name_field, players)
        if not target:
            continue
        # 장비 종류가 명시됐고 수량 1 이면 자동 장착 가능 (DM 이 공식 등장이라 의도한 것).
        # 단 자동 장착은 아무 알림 없이 끝나면 혼란 → 이벤트로 보내 클라가 토스트 안내.
        auto_equipped = False
        if kind == "equipment" and slot in ("weapon", "armor", "accessory") and qty == 1:
            replaced = target.equip_to_slot(slot, item, effect)
            auto_equipped = True
            gained.append({
                "name": target.name, "item": item, "effect": effect,
                "quantity": 1, "kind": kind, "slot": slot,
                "auto_equipped": True, "replaced": replaced,
            })
            continue
        target.grant_item(item, effect, qty, kind=kind)
        gained.append({
            "name": target.name, "item": item, "effect": effect,
            "quantity": qty, "kind": kind, "slot": slot,
            "auto_equipped": False, "replaced": None,
        })
    return gained


def parse_and_use_items(text: str, players: Dict[str, "Player"]) -> List[Tuple[str, str, int, int]]:
    """소모품 사용 파싱. (플레이어명, 아이템명, 사용량, 남은 수량) 리스트 반환."""
    used: List[Tuple[str, str, int, int]] = []
    for m in ITEM_USE_PATTERN.finditer(text):
        name_field = m.group(1).strip()
        raw_item = m.group(2).strip()
        # '장비 해제' 는 아래 전용 파서로 따로 처리 — 여기선 스킵.
        if raw_item.startswith("해제") or "장비" in name_field:
            continue
        item, qty = _split_qty(raw_item)
        if not item or qty < 1 or qty > 99:
            continue
        target = _match_player(name_field, players)
        if not target:
            continue
        result = target.use_item(item, qty)
        if result:
            used.append((target.name, result["name"], result["used"], result["remaining"]))
    return used


# 슬롯 이름 한↔영 매핑 — DM 이 "무기/방어구/장신구" 로 써도 수용.
_SLOT_ALIASES = {
    "weapon": "weapon", "무기": "weapon",
    "armor": "armor", "방어구": "armor", "갑옷": "armor",
    "accessory": "accessory", "장신구": "accessory", "악세서리": "accessory",
}


def parse_and_unequip(text: str, players: Dict[str, "Player"]) -> List[Tuple[str, str, str]]:
    """장비 해제 파싱 — 무기 투척/파괴/분실 등으로 장착 해제. (플레이어명, 슬롯, 이전 장비명) 반환.
    이전 장비명은 UI 토스트용. 해제 후 equipped[slot] = {'name': '', 'effect': None}."""
    out: List[Tuple[str, str, str]] = []
    for m in EQUIP_UNEQUIP_PATTERN.finditer(text):
        name_field = m.group(1).strip()
        raw_slot = m.group(2).strip().lower()
        slot = _SLOT_ALIASES.get(raw_slot)
        if not slot:
            continue
        target = _match_player(name_field, players)
        if not target:
            continue
        cur = target.equipped.get(slot) or {}
        prev_name = cur.get("name") if isinstance(cur, dict) else str(cur or "")
        if not prev_name:
            continue  # 이미 빈 슬롯
        target.equipped[slot] = {"name": "", "effect": None}
        out.append((target.name, slot, prev_name))
    return out


def _players_with_equip(equip_name: str, players: Dict[str, "Player"]) -> List["Player"]:
    out: List["Player"] = []
    for p in players.values():
        for slot in p.equipped.values():
            if isinstance(slot, dict) and slot.get("name") == equip_name:
                out.append(p)
                break
    return out


def _players_with_item(item_name: str, players: Dict[str, "Player"]) -> List["Player"]:
    out: List["Player"] = []
    for p in players.values():
        if any(it.get("name") == item_name for it in p.inventory):
            out.append(p)
    return out


def parse_and_reveal_equip_effects(text: str, players: Dict[str, "Player"]) -> List[Tuple[str, str, str]]:
    """장비 효과 공개. 두 가지 포맷 허용 — 지목형(우선) + 생략형(파티에 1명만 보유 시).
    반환: (플레이어명, 장비명, 효과) 리스트.
    이미 지목형으로 처리된 (span 범위) 부분은 생략형 재파싱에서 스킵 — 중복 적용 방지.
    부분 매칭 기반 (Player.reveal_equipment_effect) 은 **정확 일치만** 쓰도록 내부도 엄격화됨."""
    revealed: List[Tuple[str, str, str]] = []
    consumed_spans: List[Tuple[int, int]] = []
    # (A) 지목형
    for m in EQUIP_EFFECT_PATTERN_P.finditer(text):
        player_name = m.group(1).strip()
        equip_name  = m.group(2).strip()
        effect      = m.group(3).strip()
        if not player_name or not equip_name or not effect or len(effect) > 120:
            continue
        target = _match_player(player_name, players)
        if not target:
            print(f"[EQUIP-EFFECT MISS] player {player_name!r} not found -> tag ignored")
            continue
        if target.reveal_equipment_effect(equip_name, effect):
            revealed.append((target.name, equip_name, effect))
        consumed_spans.append(m.span())
    def _in_consumed(span):
        s, e = span
        return any(cs <= s and e <= ce for cs, ce in consumed_spans)
    # (B) 생략형 — 해당 장비를 **정확히 1명** 만 들고 있을 때만 적용
    for m in EQUIP_EFFECT_PATTERN.finditer(text):
        if _in_consumed(m.span()):
            continue
        equip_name = m.group(1).strip()
        effect     = m.group(2).strip()
        if not equip_name or not effect or len(effect) > 120:
            continue
        owners = _players_with_equip(equip_name, players)
        if len(owners) != 1:
            print(f"[EQUIP-EFFECT AMBIG] {equip_name!r} matches {len(owners)} players -> tag ignored")
            continue
        target = owners[0]
        if target.reveal_equipment_effect(equip_name, effect):
            revealed.append((target.name, equip_name, effect))
    return revealed


def parse_and_reveal_item_effects(text: str, players: Dict[str, "Player"]) -> List[Tuple[str, str, str]]:
    """아이템 효과 공개. 지목형 우선 + 생략형은 1명 보유 시만. 중복 방지 로직 동일."""
    revealed: List[Tuple[str, str, str]] = []
    consumed_spans: List[Tuple[int, int]] = []
    for m in ITEM_EFFECT_PATTERN_P.finditer(text):
        player_name = m.group(1).strip()
        item_name   = m.group(2).strip()
        effect      = m.group(3).strip()
        if not player_name or not item_name or not effect or len(effect) > 120:
            continue
        target = _match_player(player_name, players)
        if not target:
            print(f"[ITEM-EFFECT MISS] player {player_name!r} not found -> tag ignored")
            continue
        if target.reveal_item_effect(item_name, effect):
            revealed.append((target.name, item_name, effect))
        consumed_spans.append(m.span())
    def _in_consumed(span):
        s, e = span
        return any(cs <= s and e <= ce for cs, ce in consumed_spans)
    for m in ITEM_EFFECT_PATTERN.finditer(text):
        if _in_consumed(m.span()):
            continue
        item_name = m.group(1).strip()
        effect    = m.group(2).strip()
        if not item_name or not effect or len(effect) > 120:
            continue
        owners = _players_with_item(item_name, players)
        if len(owners) != 1:
            print(f"[ITEM-EFFECT AMBIG] {item_name!r} matches {len(owners)} players -> tag ignored")
            continue
        target = owners[0]
        if target.reveal_item_effect(item_name, effect):
            revealed.append((target.name, item_name, effect))
    return revealed


# ── 시간대 파싱 ────────────────────────────────
TIME_PATTERN = re.compile(r"\[(🌅|☀️|🌞|🌆|🌙|🌌)\s*([^\]]+?)\]")

# 시간 순서 — 작을수록 이른 시각. 역행 방지에 사용.
TIME_ORDER = {"🌅": 0, "☀️": 1, "🌞": 2, "🌆": 3, "🌙": 4, "🌌": 5}

# 태그 없을 때 키워드로 추정할 폴백 테이블
TIME_FALLBACK = [
    ("🌌", "심야", ["심야", "한밤", "자정", "새벽 1시", "새벽 2시", "새벽 3시"]),
    ("🌙", "밤",   ["밤", "어둠이 내린", "달빛"]),
    ("🌆", "황혼", ["황혼", "저녁", "노을", "해질녘", "석양"]),
    ("🌞", "정오", ["정오", "한낮"]),
    ("☀️", "아침", ["아침", "오전", "햇살"]),
    ("🌅", "새벽", ["새벽", "동틀", "여명", "이른 아침"]),
]


def parse_time_tag(text: str) -> Optional[dict]:
    """1차: 이모지 태그 포맷. 2차: 키워드 폴백. 없으면 None.
    반환 딕트에 ordinal 포함 (시간 역행 방지 비교용)."""
    m = TIME_PATTERN.search(text[:300])
    if m:
        icon = m.group(1)
        return {"icon": icon, "label": m.group(2).strip(), "ordinal": TIME_ORDER.get(icon, -1)}
    head = text[:300]
    for icon, label, keywords in TIME_FALLBACK:
        if any(k in head for k in keywords):
            return {"icon": icon, "label": label, "ordinal": TIME_ORDER.get(icon, -1)}
    return None


# ── 레벨 & XP 공식 ─────────────────────────────
def xp_needed_for(level: int) -> int:
    """해당 레벨에 도달하는 데 필요한 누적 XP 임계값.
    Lv2: 100, Lv3: 250, Lv4: 450, Lv5: 700, Lv6: 1000 ..."""
    if level <= 1:
        return 0
    total = 0
    inc = 100  # 레벨마다 증분 +50
    for _ in range(level - 1):
        total += inc
        inc += 50
    return total


class Player:
    def __init__(self, player_id: str, name: str, character_class: str,
                 race: Optional[str] = None, weapon_choice: Optional[str] = None,
                 race_animal: Optional[str] = None, race_ratio: Optional[int] = None):
        self.player_id = player_id
        self.name = name
        self.character_class = character_class
        self.race = race or pick_random_race()
        # 🆕 수인 서브 속성. validate_race_params 로 미리 걸러지지만 Player 단에서도 방어적 검증.
        # 다른 종족이면 None 유지.
        self.race_animal: Optional[str] = None
        self.race_ratio: Optional[int] = None
        if self.race == "수인":
            # silent fallback 제거 — 유효한 값이 아니면 명시적 ValueError.
            if race_animal not in BEASTFOLK_ANIMALS:
                raise ValueError(f"지원하지 않는 수인 동물: {race_animal!r}")
            try:
                r = int(race_ratio) if race_ratio is not None else BEASTFOLK_RATIO_MIN + (BEASTFOLK_RATIO_MAX - BEASTFOLK_RATIO_MIN) // 2
            except (TypeError, ValueError):
                raise ValueError("수인 비율은 정수여야 합니다.")
            if r < BEASTFOLK_RATIO_MIN or r > BEASTFOLK_RATIO_MAX:
                raise ValueError(f"수인 비율은 {BEASTFOLK_RATIO_MIN}~{BEASTFOLK_RATIO_MAX} 범위여야 합니다.")
            self.race_animal = race_animal
            self.race_ratio = r
        # GameRoom 이 플레이어를 바인딩할 때 설정 — custom_portrait URL 라우트 생성에 사용.
        self._room_id: Optional[str] = None
        stats = CLASS_STATS.get(character_class, CLASS_STATS["전사"])
        race_info = RACES.get(self.race, RACES["인간"])
        self.hp = stats["hp"]
        self.max_hp = stats["hp"]
        # 모든 클래스가 mp 키 보유 — dead code 였던 폴백 50 제거.
        self.mp = stats["mp"]
        self.max_mp = stats["mp"]
        self.attack = stats["attack"]
        self.defense = stats["defense"]
        # 🆕 6 ability scores — 모든 신규 캐릭터는 10 으로 시작.
        # 대기실에서 [7, 13] 범위로 자유 재분배 (총합 60 유지) → 준비 완료 시 race_mod 적용.
        # 종족·동물 보정은 apply_race_modifiers() 가 호출될 때 random 1~3 으로 추가됨.
        # (기존: 생성 시점에 race_mod 가 fixed 값으로 즉시 적용됐음 → 사용자 사전 조정 불가)
        self.strength     = ABILITY_BASE
        self.intelligence = ABILITY_BASE
        self.wisdom       = ABILITY_BASE
        self.dexterity    = ABILITY_BASE
        self.charisma     = ABILITY_BASE
        self.constitution = ABILITY_BASE
        self.race_mod_applied = False  # 🆕 종족 보정이 적용됐는지 — 게임 시작 시 한 번만 True
        self.emoji = stats["emoji"]
        self.race_emoji = (BEASTFOLK_ANIMALS[self.race_animal]["emoji"]
                           if self.race == "수인" and self.race_animal in BEASTFOLK_ANIMALS
                           else race_info["emoji"])
        self.race_desc = race_info["desc"]
        self.portrait_url = build_portrait_url(character_class, self.race, name,
                                               self.race_animal, self.race_ratio)
        self.custom_portrait: Optional[str] = None  # data URL (유저가 그린 그림)
        self.level = 1
        self.xp = 0
        # 🆕 장착 장비 3슬롯 (weapon/armor/accessory). 기본 템은 클래스별로 주어짐.
        default_eq = stats.get("equipped", {})
        # 🆕 무기 선택: 클래스의 weapon_options 중 하나면 그걸로 치환, 아니면 기본.
        initial_weapon = default_eq.get("weapon", "")
        initial_weapon_effect: Optional[str] = None
        # 기본 무기가 weapon_options 안에 같은 이름으로 있으면 그 effect 를 기본 effect 로 매핑.
        # (예전: 명시 선택 시만 effect 표시, 기본값은 빈칸 → 같은 무기인데 플레이어마다 effect 존재 여부가 달라지는 비대칭 제거.)
        for opt in stats.get("weapon_options", []):
            if opt.get("name") == initial_weapon:
                initial_weapon_effect = opt.get("effect")
                break
        if weapon_choice:
            for opt in stats.get("weapon_options", []):
                if opt.get("name") == weapon_choice:
                    initial_weapon = opt["name"]
                    initial_weapon_effect = opt.get("effect")
                    break
        # 장비 각 슬롯 → {name, effect}. effect=None 이면 "아직 잘 모르겠다".
        self.equipped: Dict[str, Dict[str, Optional[str]]] = {
            "weapon":    {"name": initial_weapon,                  "effect": initial_weapon_effect},
            "armor":     {"name": default_eq.get("armor", ""),     "effect": None},
            "accessory": {"name": default_eq.get("accessory", ""), "effect": None},
        }
        # 🆕 소지 금액 (gold) — DM 이 거래/전리품 태그로 변경.
        self.gold: int = int(stats.get("gold", 50))
        # 인벤토리는 {name, effect|None, quantity, kind} 딕트 리스트.
        # kind: "consumable" (디폴트) | "equipment" | "quest"
        self.inventory: List[Dict[str, Optional[str]]] = []
        self.is_ready: bool = False  # 대기실 준비 토글
        # 다음 행동 LLM 호출에 포함시킬 시스템 메모 (예: 새 초상화 그림 공개)
        self.pending_notes: List[str] = []
        # 🆕 상태 효과 (버프/디버프). {name, kind: '버프'|'디버프', turns_remaining, effect}
        self.status_effects: List[Dict] = []
        # 🆕 레벨업 시 적립되는 사용자 분배 가능 포인트. 클라에서 spend_stat_point 로 소비.
        self.stat_points: int = 0

    def effective_portrait(self) -> str:
        """브로드캐스트/로그에 실리는 초상화 참조.
        커스텀 그림이 있으면 **데이터 URL 원본이 아니라** `/portrait/{room}/{pid}` 라우트 URL 을 반환.
        data URL (최대 ~1.4 MB) 이 매 DM 응답마다 재전송되는 걸 막는다.
        `?v=<hash>` 로 캐시버스팅 — 그림 내용이 바뀌면 브라우저가 자동 재요청."""
        if self.custom_portrait and self._room_id:
            # 전체 data URL 을 해시 — 앞 256 바이트만 쓰면 같은 캔버스 크기의 JPEG 두 장이
            # 헤더/양자화테이블이 동일해서 충돌 → ?v 가 바뀌지 않아 브라우저가 캐시된 옛 그림을 계속 보여줌
            h = hashlib.md5(self.custom_portrait.encode("utf-8", errors="ignore")).hexdigest()[:8]
            return f"/portrait/{self._room_id}/{self.player_id}?v={h}"
        return self.portrait_url

    def has_item(self, name: str) -> bool:
        return any(it["name"] == name for it in self.inventory)

    def grant_item(self, name: str, effect: Optional[str] = None, qty: int = 1,
                   kind: str = "consumable") -> bool:
        """인벤토리에 아이템 추가. 이미 있으면 수량 누적 (효과·종류 빈 경우 채움).
        실제로 **새** 항목이 추가됐으면 True (수량만 늘었으면 False).
        kind: 'consumable' / 'equipment' / 'quest'."""
        if qty < 1:
            qty = 1
        if kind not in ("consumable", "equipment", "quest"):
            kind = "consumable"
        for it in self.inventory:
            if it["name"] == name:
                it["quantity"] = it.get("quantity", 1) + qty
                if effect and not it.get("effect"):
                    it["effect"] = effect
                # 종류가 빈/소모품이고 새 정보가 더 구체적이면 갱신
                if it.get("kind", "consumable") == "consumable" and kind != "consumable":
                    it["kind"] = kind
                return False
        self.inventory.append({"name": name, "effect": effect, "quantity": qty, "kind": kind})
        return True

    def equip_to_slot(self, slot: str, name: str, effect: Optional[str]) -> Optional[dict]:
        """slot 에 새 장비 장착. 기존 장비가 있으면 인벤토리(kind=equipment)로 회수.
        반환: 회수된 장비 dict {name, effect} 또는 None.
        slot: 'weapon' / 'armor' / 'accessory'."""
        if slot not in self.equipped:
            return None
        prev = self.equipped.get(slot) or {}
        prev_name = prev.get("name") if isinstance(prev, dict) else None
        prev_effect = prev.get("effect") if isinstance(prev, dict) else None
        self.equipped[slot] = {"name": name, "effect": effect}
        if prev_name:
            self.grant_item(prev_name, prev_effect, 1, kind="equipment")
            return {"name": prev_name, "effect": prev_effect}
        return None

    def equip_from_inventory(self, item_name: str, slot: str) -> Optional[dict]:
        """플레이어가 인벤토리 아이템을 명시적으로 장착. 인벤토리에서 1개 차감하고
        equip_to_slot 호출. 기존 장비는 회수.
        반환: {item, slot, effect, replaced{name,effect}|None} 또는 None(실패).
        """
        if slot not in self.equipped:
            return None
        idx = -1
        for i, it in enumerate(self.inventory):
            if it.get("name") == item_name:
                idx = i
                break
        if idx < 0:
            return None
        it = self.inventory[idx]
        effect = it.get("effect")
        # 인벤토리에서 1 차감 (수량 0 이면 제거)
        qty = it.get("quantity", 1)
        if qty <= 1:
            self.inventory.pop(idx)
        else:
            it["quantity"] = qty - 1
        replaced = self.equip_to_slot(slot, item_name, effect)
        return {"item": item_name, "slot": slot, "effect": effect, "replaced": replaced}

    def use_item(self, name: str, qty: int = 1) -> Optional[dict]:
        """소모품 사용 — 수량 감소, 0이면 제거. 실제 감소된 아이템 dict 반환 (없으면 None).
        이름 부분 매칭 허용 ('건빵' → '맛없는 건빵')."""
        if qty < 1:
            qty = 1
        target_idx = -1
        for i, it in enumerate(self.inventory):
            if it["name"] == name:
                target_idx = i
                break
        if target_idx < 0:
            for i, it in enumerate(self.inventory):
                if name in it["name"] or it["name"] in name:
                    target_idx = i
                    break
        if target_idx < 0:
            return None
        it = self.inventory[target_idx]
        current = it.get("quantity", 1)
        new_qty = current - qty
        if new_qty <= 0:
            self.inventory.pop(target_idx)
            return {"name": it["name"], "used": current, "remaining": 0}
        it["quantity"] = new_qty
        return {"name": it["name"], "used": qty, "remaining": new_qty}

    def reveal_equipment_effect(self, name: str, effect: str) -> bool:
        """장착 중인 장비의 효과 공개 — **정확 매칭만**."""
        for slot in self.equipped.values():
            if not slot.get("name"):
                continue
            if slot["name"] == name:
                slot["effect"] = effect
                return True
        return False

    def reveal_item_effect(self, name: str, effect: str) -> bool:
        """인벤토리 아이템 효과 공개 — **정확 매칭만**.
        부분 매칭은 '반지' 가 '볼카르 인장 반지' 에 오탐을 유발해 제거."""
        for it in self.inventory:
            if it["name"] == name:
                it["effect"] = effect
                return True
        return False

    def grant_xp(self, amount: int) -> Optional[dict]:
        """XP 적립. 레벨업 시 {new_level, gains, levels_gained} 반환, 아니면 None.
        보상:
        - max_hp +10 / max_mp +5 / attack +2 (레벨마다 자동)
        - 현재 HP/MP **풀회복 아님** — 증가분만 현재 수치에 더함. 이렇게 하면 "피 흘리며 승리 후 레벨업" 서사가 수치로도 살아남고, HP 1 까지 몰아놓고 레벨업으로 풀피 찍는 치트 루프가 막힌다.
        - stat_points +3 (체력/마력/공격/방어에 수동 분배)."""
        if amount <= 0:
            return None
        self.xp += amount
        levels_gained = 0
        gains = {"max_hp": 0, "max_mp": 0, "attack": 0, "stat_points": 0}
        while self.xp >= xp_needed_for(self.level + 1):
            self.level += 1
            self.max_hp += 10
            self.max_mp += 5
            self.attack += 2
            # 풀회복 대신 증가분만 현재 수치에 더함 → 비율이 대체로 유지됨.
            self.hp = min(self.max_hp, self.hp + 10)
            self.mp = min(self.max_mp, self.mp + 5)
            self.stat_points += 3
            gains["max_hp"] += 10
            gains["max_mp"] += 5
            gains["attack"] += 2
            gains["stat_points"] += 3
            levels_gained += 1
        if levels_gained == 0:
            return None
        return {"new_level": self.level, "gains": gains, "levels_gained": levels_gained}

    def spend_stat_point(self, stat: str) -> Optional[dict]:
        """stat 에 포인트 1 투자. 반환: 적용된 증가분 dict 또는 None(불가).
        🆕 지원 stat:
          - 파생 스탯 (legacy): 'max_hp'(+5) / 'max_mp'(+5) / 'attack'(+1) / 'defense'(+1)
          - 6 ability (DND): 'strength'/'intelligence'/'wisdom'/'dexterity'/'constitution' (+1)
          - 'charisma' 는 생성 시 고정 — 절대 거부 (None 반환).
        파생 스탯과 ability 는 같은 stat_points 풀을 공유 — 플레이어가 자유 분배."""
        if self.stat_points < 1:
            return None
        # 매력은 생성 시 고정 — 명시적 차단
        if stat == "charisma":
            return None
        # 파생 스탯 (이전 시스템 그대로 유지 — 회귀 방지)
        legacy_map = {"max_hp": 5, "max_mp": 5, "attack": 1, "defense": 1}
        if stat in legacy_map:
            delta = legacy_map[stat]
            if stat == "max_hp":
                self.max_hp += delta
                self.hp = min(self.hp + delta, self.max_hp)  # 현재 HP 도 같이 올려 체감 보상
            elif stat == "max_mp":
                self.max_mp += delta
                self.mp = min(self.mp + delta, self.max_mp)
            elif stat == "attack":
                self.attack += delta
            elif stat == "defense":
                self.defense += delta
            self.stat_points -= 1
            return {"stat": stat, "delta": delta, "remaining_points": self.stat_points}
        # 🆕 6 ability — CHA 제외 5개만 +1
        if stat in LEVELABLE_ABILITIES:
            cur = getattr(self, stat, ABILITY_BASE)
            if cur >= ABILITY_MAX:
                return None
            setattr(self, stat, cur + 1)
            self.stat_points -= 1
            return {"stat": stat, "delta": 1, "remaining_points": self.stat_points}
        return None

    # ── 상태 효과 (버프/디버프) ──
    def apply_status(self, kind: str, name: str, turns: int, effect: Optional[str]):
        """버프/디버프 적용. 같은 이름(+같은 종류)이 이미 있으면 턴/설명 갱신."""
        for st in self.status_effects:
            if st["name"] == name and st["kind"] == kind:
                st["turns_remaining"] = turns
                if effect:
                    st["effect"] = effect
                return
        self.status_effects.append({
            "kind": kind, "name": name,
            "turns_remaining": turns, "effect": effect,
        })

    def tick_statuses(self) -> List[dict]:
        """모든 상태 효과의 남은 턴 -1. 0 이하인 것들은 제거, expired 리스트로 반환."""
        expired: List[dict] = []
        kept: List[dict] = []
        for st in self.status_effects:
            st["turns_remaining"] -= 1
            if st["turns_remaining"] <= 0:
                expired.append({
                    "player_name": self.name,
                    "kind": st["kind"], "name": st["name"],
                })
            else:
                kept.append(st)
        self.status_effects = kept
        return expired

    def xp_to_next(self) -> int:
        """다음 레벨까지 남은 XP."""
        return max(0, xp_needed_for(self.level + 1) - self.xp)

    def is_alive(self) -> bool:
        """🆕 HP > 0 = 생존. 사망 시 행동 차단·턴 자동 스킵·UI 그레이스케일에 사용."""
        return self.hp > 0

    # ── 🆕 포인트 바이 (대기실 능력치 조정) ─────────────
    def ability_total(self) -> int:
        """6 ability 합계. 대기실에서 PREGAME_TOTAL_BUDGET(60) 으로 유지해야 준비 가능."""
        return sum(int(getattr(self, k, ABILITY_BASE)) for k in ABILITY_KEYS)

    def adjust_pregame_stat(self, stat: str, delta: int) -> Optional[dict]:
        """대기실 ±1 조정. 범위 [PREGAME_STAT_MIN, PREGAME_STAT_MAX].
        race_mod_applied 면 거부 (게임 시작 후엔 spend_stat_point 사용).
        반환: {stat, value, total} 또는 None (거부)."""
        if self.race_mod_applied:
            return None
        if stat not in ABILITY_KEYS:
            return None
        if delta not in (-1, 1):
            return None
        cur = int(getattr(self, stat, ABILITY_BASE))
        new_val = cur + delta
        if new_val < PREGAME_STAT_MIN or new_val > PREGAME_STAT_MAX:
            return None
        setattr(self, stat, new_val)
        return {"stat": stat, "value": new_val, "total": self.ability_total()}

    def apply_race_modifiers(self) -> Optional[dict]:
        """🆕 종족·동물 보정을 random magnitude 1~3 으로 한 번만 적용.
        부호는 RACE_ABILITY_MOD / BEASTFOLK_ABILITY_MOD 에 정의된 값에서 가져오고,
        |크기| 는 매번 random.randint(1, 3) — 같은 종족이라도 캐릭터마다 변이.
        반환: {stat: applied_delta, ...} (디버그·UI 표시용) 또는 None (이미 적용됨)."""
        if self.race_mod_applied:
            return None
        applied: Dict[str, int] = {}
        sources: List[Dict[str, int]] = []
        race_src = RACE_ABILITY_MOD.get(self.race or "", {})
        if race_src:
            sources.append(race_src)
        if self.race == "수인" and self.race_animal in BEASTFOLK_ABILITY_MOD:
            sources.append(BEASTFOLK_ABILITY_MOD[self.race_animal])
        for src in sources:
            for stat, sign_val in src.items():
                if not sign_val:
                    continue
                sign = 1 if sign_val > 0 else -1
                magnitude = random.randint(1, 3)
                delta = sign * magnitude
                cur = int(getattr(self, stat, ABILITY_BASE))
                new_val = max(ABILITY_MIN, min(ABILITY_MAX, cur + delta))
                setattr(self, stat, new_val)
                applied[stat] = applied.get(stat, 0) + (new_val - cur)  # 실제 적용된 변화량 (clamp 반영)
        self.race_mod_applied = True
        return applied

    def to_dict(self):
        return {
            "player_id": self.player_id,
            "name": self.name,
            "character_class": self.character_class,
            "race": self.race,
            "race_animal": self.race_animal,        # 🆕 수인 전용
            "race_ratio": self.race_ratio,          # 🆕 수인 전용 (0~100)
            "race_emoji": self.race_emoji,
            "race_desc": self.race_desc,
            "hp": self.hp,
            "max_hp": self.max_hp,
            "mp": self.mp,                          # 🆕
            "max_mp": self.max_mp,                  # 🆕
            "attack": self.attack,
            "defense": self.defense,
            "emoji": self.emoji,
            "portrait_url": self.effective_portrait(),
            "has_custom_portrait": self.custom_portrait is not None,
            "level": self.level,
            "xp": self.xp,
            "xp_to_next": self.xp_to_next(),
            "stat_points": self.stat_points,        # 🆕 미분배 스탯 포인트
            "gold": self.gold,                      # 🆕 소지 금액
            "equipped": dict(self.equipped),        # 🆕 장착 장비
            "inventory": [dict(it) for it in self.inventory],
            "is_ready": self.is_ready,
            "status_effects": [dict(st) for st in self.status_effects],
            "is_dead": not self.is_alive(),         # 🆕 사망 여부 — 클라가 그레이스케일/행동 비활성에 사용
            # 🆕 6 ability scores (DND PHB) — UI 패널 + 능력 판정 표시
            "strength":     self.strength,
            "intelligence": self.intelligence,
            "wisdom":       self.wisdom,
            "dexterity":    self.dexterity,
            "charisma":     self.charisma,
            "constitution": self.constitution,
            "race_mod_applied": self.race_mod_applied,  # 🆕 클라가 사전 조정 패널 표시 여부 결정
            "ability_total":   self.ability_total(),    # 🆕 클라 budget 표시용
        }

    # ── 디스크 저장용 직렬화 (to_dict 와 다름: pending_notes, custom_portrait 원본 포함) ──
    def to_save_dict(self):
        return {
            "player_id": self.player_id,
            "name": self.name,
            "character_class": self.character_class,
            "race": self.race,
            "race_animal": self.race_animal,
            "race_ratio": self.race_ratio,
            "hp": self.hp, "max_hp": self.max_hp,
            "mp": self.mp, "max_mp": self.max_mp,
            "attack": self.attack, "defense": self.defense,
            "level": self.level, "xp": self.xp,
            "stat_points": self.stat_points,
            "gold": self.gold,
            "custom_portrait": self.custom_portrait,
            "equipped": dict(self.equipped),
            "inventory": [dict(it) for it in self.inventory],
            "is_ready": self.is_ready,
            "pending_notes": list(self.pending_notes),
            "status_effects": [dict(st) for st in self.status_effects],
            # 🆕 6 ability scores 영구 저장
            "strength":     self.strength,
            "intelligence": self.intelligence,
            "wisdom":       self.wisdom,
            "dexterity":    self.dexterity,
            "charisma":     self.charisma,
            "constitution": self.constitution,
            "race_mod_applied": self.race_mod_applied,  # 🆕 종족 보정 적용 여부
        }

    @classmethod
    def from_save_dict(cls, d):
        # 구버전 세이브에서 수인 ratio 가 0 또는 100 으로 저장된 경우 허용 범위로 clamp해서 로드 실패 방지.
        race = d.get("race")
        race_animal = d.get("race_animal")
        race_ratio = d.get("race_ratio")
        if race == "수인":
            if race_animal not in BEASTFOLK_ANIMALS:
                print(f"[LOAD WARN] {d.get('name')}: unsupported beastfolk animal {race_animal!r} → 늑대로 교체")
                race_animal = "늑대"
            try:
                r = int(race_ratio) if race_ratio is not None else 50
            except (TypeError, ValueError):
                r = 50
            race_ratio = max(BEASTFOLK_RATIO_MIN, min(BEASTFOLK_RATIO_MAX, r))
        p = cls(d["player_id"], d["name"], d["character_class"], race,
                race_animal=race_animal, race_ratio=race_ratio)
        # 능력치 복원 (__init__ 기본값 덮어쓰기)
        if "hp" in d: p.hp = d["hp"]
        if "max_hp" in d: p.max_hp = d["max_hp"]
        if "mp" in d: p.mp = d["mp"]
        if "max_mp" in d: p.max_mp = d["max_mp"]
        if "attack" in d: p.attack = d["attack"]
        if "defense" in d: p.defense = d["defense"]
        if "level" in d: p.level = d["level"]
        if "xp" in d: p.xp = d["xp"]
        if "stat_points" in d: p.stat_points = int(d.get("stat_points", 0) or 0)
        if "gold" in d:
            try:
                p.gold = max(0, int(d.get("gold", 0) or 0))
            except (TypeError, ValueError):
                pass
        p.custom_portrait = d.get("custom_portrait")
        if "equipped" in d and isinstance(d["equipped"], dict):
            for slot, val in d["equipped"].items():
                if isinstance(val, dict):
                    p.equipped[slot] = {"name": val.get("name", ""), "effect": val.get("effect")}
                elif isinstance(val, str):
                    p.equipped[slot] = {"name": val, "effect": None}
        # inventory 복원 — kind 가 빠진 구버전은 'consumable' 디폴트.
        new_inv: List[Dict[str, Optional[str]]] = []
        for it in d.get("inventory", []):
            if isinstance(it, dict):
                d2 = dict(it)
                d2.setdefault("kind", "consumable")
                d2.setdefault("quantity", 1)
                new_inv.append(d2)
            else:
                new_inv.append({"name": str(it), "effect": None, "quantity": 1, "kind": "consumable"})
        p.inventory = new_inv
        p.is_ready = bool(d.get("is_ready", False))
        p.pending_notes = list(d.get("pending_notes", []))
        p.status_effects = [dict(st) for st in d.get("status_effects", []) if isinstance(st, dict)]
        # 🆕 6 ability scores 복원
        # 신규 Player.__init__ 은 모두 10 으로 시작 (race_mod_applied=False).
        # save 에 능력치가 있으면 그대로 덮어쓰기. race_mod_applied 가 빠진 구버전 save 는 True 로 간주
        # (이미 race 보정이 적용된 값이 저장돼 있다고 가정 — 회귀 방지).
        for ab in ABILITY_KEYS:
            if ab in d:
                try:
                    setattr(p, ab, max(ABILITY_MIN, min(ABILITY_MAX, int(d[ab]))))
                except (TypeError, ValueError):
                    pass
        # race_mod_applied 명시되면 그 값, 없으면 True (구버전 호환 — 이미 적용됐다고 봄)
        p.race_mod_applied = bool(d.get("race_mod_applied", True))
        return p


class Monster:
    """전투 중인 적 유닛. DM 태그로 생성/HP/상태/퇴장 관리.
    HP 가 0 으로 떨어지면 자동 제거. 파티 패널 하단 '몬스터' 섹션에 카드로 노출된다.

    🆕 status_effects: 플레이어와 동일 구조의 버프/디버프 리스트.
       디버프 효과 설명(`매 턴 -4 HP` 등)에서 숫자가 잡히면 round_complete 시 HP 자동 감소.
    🆕 attackers: 이 몬스터를 때린 player_id 의 등장 순서 보존 리스트(중복 제거).
       처치 시 last attacker = 처치자, 나머지 = 어시스트로 XP 분배."""
    def __init__(self, name: str, max_hp: int, speed: int = 10):
        self.name = name
        self.max_hp = max(1, int(max_hp))
        self.hp = self.max_hp
        self.status_note: Optional[str] = None
        self.status_effects: List[Dict] = []
        self.attackers: List[str] = []
        # 🆕 speed (기교에 해당) — initiative 굴림에 사용. 기본 10. DM 이 등장 태그에서 명시 가능.
        # 작은 몬스터(쥐·고블린): 12~14, 일반: 10, 무거운 적(트롤·곰): 6~8.
        self.speed = max(1, int(speed))

    def apply_status(self, kind: str, name: str, turns: int, effect: Optional[str]):
        """플레이어와 동일 — 같은 (kind, name) 이 이미 있으면 갱신, 없으면 추가."""
        for st in self.status_effects:
            if st["name"] == name and st["kind"] == kind:
                st["turns_remaining"] = turns
                if effect:
                    st["effect"] = effect
                return
        self.status_effects.append({
            "kind": kind, "name": name,
            "turns_remaining": turns, "effect": effect,
        })

    def tick_statuses(self) -> Tuple[List[dict], int]:
        """모든 status 의 남은 턴 -1, 디버프 면 HP 깎임. (expired_list, total_damage_dealt) 반환."""
        damage = 0
        expired: List[dict] = []
        kept: List[dict] = []
        for st in self.status_effects:
            if st["kind"] == "디버프":
                d = _parse_dot_damage(st.get("effect") or st.get("name") or "")
                if d > 0:
                    damage += d
            st["turns_remaining"] -= 1
            if st["turns_remaining"] <= 0:
                expired.append({
                    "monster_name": self.name,
                    "kind": st["kind"], "name": st["name"],
                })
            else:
                kept.append(st)
        self.status_effects = kept
        if damage > 0:
            self.hp = max(0, self.hp - damage)
        return expired, damage

    def note_attacker(self, player_id: str):
        """이 플레이어가 한 번이라도 때렸다는 사실 기록. 등장 순서 유지(처치자 판정용)."""
        if player_id and player_id not in self.attackers:
            self.attackers.append(player_id)
        elif player_id:
            # 다시 때리면 마지막으로 이동 — 마지막 공격자가 처치자.
            self.attackers.remove(player_id)
            self.attackers.append(player_id)

    def to_dict(self):
        return {
            "name": self.name,
            "hp": self.hp,
            "max_hp": self.max_hp,
            "status_note": self.status_note,
            "status_effects": [dict(s) for s in self.status_effects],
            "speed": self.speed,  # 🆕 UI 카드에 속도 뱃지 표시 + initiative 디버그
        }

    def to_save_dict(self):
        d = self.to_dict()
        d["attackers"] = list(self.attackers)
        return d

    @classmethod
    def from_save_dict(cls, d):
        m = cls(d.get("name", "?"), int(d.get("max_hp", 1)), int(d.get("speed", 10) or 10))
        m.hp = int(d.get("hp", m.max_hp))
        m.status_note = d.get("status_note")
        se = d.get("status_effects") or []
        if isinstance(se, list):
            m.status_effects = [dict(s) for s in se if isinstance(s, dict)]
        atk = d.get("attackers") or []
        if isinstance(atk, list):
            m.attackers = [str(a) for a in atk]
        return m


# 디버프 효과 설명에서 "매 턴 N HP 감소" 같은 패턴의 N 추출.
# `매 턴 -4 HP`, `턴마다 5 데미지`, `독 dmg 3` 등 자유 텍스트 모두 커버.
_DOT_DAMAGE_RE = re.compile(r"(?:-|마이너스|감소|뎀|데미지|피해|dmg|damage)\s*[: ]*\s*(\d+)|(\d+)\s*(?:HP|hp|뎀|데미지|피해)\s*(?:감소|-|\b)")


def _parse_dot_damage(text: str) -> int:
    """디버프 effect 텍스트에서 매 턴 가하는 HP 피해량 추출.
    잘 모르겠으면 0 반환 (그냥 turn-only 디버프로 취급)."""
    if not text:
        return 0
    best = 0
    for m in _DOT_DAMAGE_RE.finditer(text):
        for g in m.groups():
            if g and g.isdigit():
                v = int(g)
                if 0 < v <= 99 and v > best:
                    best = v
    return best


# ── 튜닝 파라미터 ─────────────────────────────
MESSAGE_HISTORY_CAP = 50           # 메모리에 유지할 최대 메시지 수
LLM_CONTEXT_WINDOW = 20            # LLM에 보낼 최근 메시지 수
ACTION_COOLDOWN_SEC = 3.0          # 플레이어당 행동 최소 간격
ROOM_CODE_MAX_RETRIES = 50         # 방 코드 충돌 시 재시도 상한
CHAT_LOG_CAP = 100                 # 대기실 채팅 최대 보관
CHAT_MAX_LEN = 200                 # 한 메시지 최대 길이
NARR_LOG_CAP = 80                  # 공개 서사 로그 최대 보관 (입장자에게 보여줌)
ACTION_MAX_LEN = 400               # 플레이어 행동 텍스트 상한 (프롬프트 주입 완화)
# 🆕 dormant(휴면) 관련
DORMANT_TAKEOVER_DELAY_SEC = 120   # 나간 후 이 시간이 지나야 타인이 그 캐릭터를 takeover 가능
DISCONNECT_DORMANT_GRACE_SEC = 90  # WS 끊긴 뒤 이 시간 안에 재접속 없으면 휴면 처리 (게임 중만)
DORMANT_EXPIRE_SEC = 24 * 3600     # 휴면 상태 24시간 경과 시 자동 제거 (메모리/네트워크 누수 방지)
# 🆕 대기실(게임 시작 전) 상태에서 연결이 전부 끊기면 이 시간만큼 방을 유지.
#    모바일 친구가 방 만들자마자 카톡으로 전환 → WS 죽음 → 바로 방 삭제 → 돌아와도 rejoin 실패
#    이슈 해결. 이 시간 안에 재접속하면 방/플레이어 그대로 복구.
LOBBY_EMPTY_GRACE_SEC = 120

# save 파일 스키마 버전 — 포맷 바뀌면 올리고 from_save_dict 에서 분기.
SAVE_SCHEMA_VERSION = 2

# ── 플레이어 입력 정화 ─────────────────────────
# 플레이어 action 텍스트가 LLM user content 로 직접 들어가므로, 대괄호 태그 포맷 문자를 전각으로 치환해
# "플레이어가 `[내 이름 XP +500]` 을 넣어 DM 이 그 패턴을 흉내내는" 주입을 완화한다.
# (DM 은 여전히 ASCII `[...]` 로 태그를 생성하므로 서버 파서와는 충돌하지 않음.)
ACTION_SANITIZE_MAP = str.maketrans({"[": "〔", "]": "〕"})


def sanitize_player_action(text: str) -> str:
    """플레이어가 쓴 행동 문자열 정화 — 태그 포맷 주입 완화."""
    if not text:
        return ""
    return text.translate(ACTION_SANITIZE_MAP)


class GameRoom:
    def __init__(self, room_id: str, scenario_id: Optional[str] = None):
        self.room_id = room_id
        # 🆕 시나리오 ID — DM 프롬프트의 세계관·톤·오프닝 훅을 결정.
        self.scenario_id: str = scenario_id if scenario_id in SCENARIOS else DEFAULT_SCENARIO_ID
        self.players: Dict[str, Player] = {}
        # 🆕 몬스터 — 전투 중 적 유닛 트래킹. DM 태그로 관리 (파티 패널 하단에 카드로 노출).
        self.monsters: Dict[str, Monster] = {}
        self.connections: Dict[str, WebSocket] = {}
        self.messages: List[dict] = []
        self.started = False
        self.owner_id: Optional[str] = None
        self.lock = asyncio.Lock()  # LLM 호출 동시성 제어
        self.current_time: Optional[dict] = None  # {icon, label, ordinal, day}
        # 🆕 일차(day) — 심야 → 새벽 래핑 감지 시 +1. 브로드캐스트 current_time 안에도 복제.
        self.day: int = 1
        self.last_action_at: Dict[str, float] = {}  # player_id → epoch
        self.chat_log: List[dict] = []   # [{player_id, name, text, ts}]
        # 🆕 공개 서사 로그 — 신규/재입장자가 지금까지의 흐름을 볼 수 있도록
        #   {"type": "dm"|"action"|"dice"|"sys", ...}
        self.narrative_log: List[dict] = []
        self.turn_order: List[str] = []  # player_id 입장 순서 (legacy — dormant·skip_turn 등 호환 유지)
        self.current_turn_index: int = 0
        # 🆕 Phase 3 — Initiative 기반 라운드 순서. 매 라운드 시작 시 roll_initiative 로 재구축.
        # 항목: {kind: 'player'|'monster', id, name, initiative, dex_or_speed}
        # round_order 가 비어있으면 시스템은 legacy turn_order 로 폴백 — 게임 중 점진 활성화.
        self.round_order: List[dict] = []
        self.round_idx: int = 0
        self.round_number: int = 0       # 1, 2, 3, ... — 매 새 라운드마다 +1 (UI 표시용)
        # 🆕 관전자 — 플레이어 목록/턴오더에 안 잡히지만 브로드캐스트는 받음.
        # {spectator_id: {"name": str, "ws": WebSocket}}
        self.spectators: Dict[str, dict] = {}
        # 🆕 휴면(dormant) 캐릭터 — 나갔지만 파티가 기억함.
        # {original_player_id: {"player": Player, "departed_at": epoch}}
        # 2분 경과하면 새 접속자가 takeover 가능. 그 전에는 원래 player_id 로만 rejoin.
        self.dormant: Dict[str, dict] = {}
        # 🆕 휴면 처리 대기 타이머 — 연결 끊김 후 N초 grace 안에 재접속 못하면 dormant 처리.
        self._pending_dormant_tasks: Dict[str, asyncio.Task] = {}
        # 🆕 대기실 전체 비어짐 → LOBBY_EMPTY_GRACE_SEC 후 방 삭제 대기 타이머.
        # 재접속 있으면 rejoin 처리에서 cancel.
        self._pending_lobby_cleanup: Optional[asyncio.Task] = None
        # 🆕 force_unlock 2단계 확인 — 대상 player_id → pending 이벤트 발송 epoch.
        # 30초 내 재전송되어야 실제 해제.
        self._pending_force_unlocks: Dict[str, float] = {}

    # ── 플레이어 등록 헬퍼 ──────────────
    def attach_player(self, player: Player):
        """플레이어를 방에 바인딩. room_id 를 플레이어에게 심어 effective_portrait URL 이 정상 생성되게 한다.
        모든 players[pid] = player 배치 경로는 이 헬퍼를 경유해야 함."""
        player._room_id = self.room_id
        self.players[player.player_id] = player

    def expire_dormant(self) -> List[str]:
        """24시간 초과된 dormant 항목 제거. 제거된 original player_id 리스트 반환."""
        if not self.dormant:
            return []
        now = time.time()
        to_remove: List[str] = []
        for pid, info in self.dormant.items():
            if now - info.get("departed_at", now) > DORMANT_EXPIRE_SEC:
                to_remove.append(pid)
        for pid in to_remove:
            self.dormant.pop(pid, None)
        return to_remove

    # ── 공개 서사 로그 ──────────────────────
    def _log_narr(self, event: dict):
        """공개 로그에 이벤트 추가 (신규/재입장자에게 노출). 상한 cap 유지."""
        event = dict(event)
        event.setdefault("ts", time.time())
        self.narrative_log.append(event)
        if len(self.narrative_log) > NARR_LOG_CAP:
            self.narrative_log = self.narrative_log[-NARR_LOG_CAP:]

    # ── 디스크 저장 직렬화 ───────────────────
    def to_save_dict(self):
        return {
            "version": SAVE_SCHEMA_VERSION,
            "room_id": self.room_id,
            "scenario_id": self.scenario_id,
            "owner_id": self.owner_id,
            "started": self.started,
            "current_time": self.current_time,
            "day": self.day,
            "messages": self.messages,
            "chat_log": self.chat_log,
            "narrative_log": self.narrative_log,
            "turn_order": list(self.turn_order),
            "current_turn_index": self.current_turn_index,
            # 🆕 Phase 3 — round state 영구화. 구버전 save 엔 없으니 from_save_dict 폴백 필요.
            "round_order": list(self.round_order),
            "round_idx": self.round_idx,
            "round_number": self.round_number,
            "players": {pid: p.to_save_dict() for pid, p in self.players.items()},
            "monsters": {k: m.to_save_dict() for k, m in self.monsters.items()},
            "dormant": {
                pid: {
                    "player": info["player"].to_save_dict() if isinstance(info.get("player"), Player) else None,
                    "departed_at": info.get("departed_at"),
                }
                for pid, info in self.dormant.items()
                if info.get("player") is not None
            },
            "saved_at": time.time(),
        }

    @classmethod
    def from_save_dict(cls, d):
        # 버전 체크 — best-effort 복원. 호환 안 되는 필드는 skip.
        loaded_ver = int(d.get("version", 1) or 1)
        if loaded_ver > SAVE_SCHEMA_VERSION:
            print(f"[LOAD WARN] {d.get('room_id')}: save version {loaded_ver} > server {SAVE_SCHEMA_VERSION} — 새 필드는 무시됩니다.")
        elif loaded_ver < SAVE_SCHEMA_VERSION:
            print(f"[LOAD] {d.get('room_id')}: migrating save v{loaded_ver} → v{SAVE_SCHEMA_VERSION}")
        # 🆕 구버전 save 는 scenario_id 필드가 없음 → 기본값(볼카르) 로 복원
        room = cls(d["room_id"], scenario_id=d.get("scenario_id"))
        room.owner_id = d.get("owner_id")
        room.started = bool(d.get("started", False))
        room.current_time = d.get("current_time")
        room.day = int(d.get("day", 1) or 1)
        # current_time 안의 day 필드가 room.day 와 어긋날 수 있으니 동기화.
        if isinstance(room.current_time, dict):
            room.current_time["day"] = room.day
        room.messages = list(d.get("messages", []))
        room.chat_log = list(d.get("chat_log", []))
        room.narrative_log = list(d.get("narrative_log", []))
        room.turn_order = list(d.get("turn_order", []))
        room.current_turn_index = int(d.get("current_turn_index", 0) or 0)
        # 🆕 Phase 3 — round state 복원 (구버전 save 엔 없을 수 있음 → 빈 상태로 폴백,
        # 다음 액션 처리에서 ensure_round_started 가 자동으로 새 라운드 굴림)
        ro = d.get("round_order")
        if isinstance(ro, list):
            room.round_order = [dict(x) for x in ro if isinstance(x, dict)]
        room.round_idx = int(d.get("round_idx", 0) or 0)
        room.round_number = int(d.get("round_number", 0) or 0)
        for pid, pdata in (d.get("players") or {}).items():
            try:
                p = Player.from_save_dict(pdata)
                p._room_id = room.room_id  # 초상화 URL 생성에 필요
                room.players[pid] = p
            except Exception as e:
                print(f"[LOAD] player {pid} skipped: {e}")
        for mk, mdata in (d.get("monsters") or {}).items():
            try:
                room.monsters[mk] = Monster.from_save_dict(mdata)
            except Exception as e:
                print(f"[LOAD] monster {mk} skipped: {e}")
        for pid, info in (d.get("dormant") or {}).items():
            try:
                p = Player.from_save_dict(info["player"])
                p._room_id = room.room_id
                room.dormant[pid] = {"player": p, "departed_at": info.get("departed_at", time.time())}
            except Exception as e:
                print(f"[LOAD] dormant {pid} skipped: {e}")
        # 로드 시 이미 24h 지난 dormant 는 정리
        removed = room.expire_dormant()
        if removed:
            print(f"[LOAD] dormant expired on load: {removed}")
        return room

    # ── 턴 관리 ──────────────────────────────
    def add_to_turn_order(self, player_id: str):
        if player_id not in self.turn_order:
            self.turn_order.append(player_id)

    def remove_from_turn_order(self, player_id: str):
        if player_id not in self.turn_order:
            return
        idx = self.turn_order.index(player_id)
        self.turn_order.pop(idx)
        if not self.turn_order:
            self.current_turn_index = 0
            return
        # 떠난 사람이 현재 턴이거나 그 앞에 있었으면 index 조정
        if idx < self.current_turn_index:
            self.current_turn_index -= 1
        self.current_turn_index %= len(self.turn_order)

    def _is_pid_alive(self, pid: str) -> bool:
        """🆕 turn_order 의 player_id 가 살아있는지. 휴면 중·삭제됨·HP 0 모두 False."""
        p = self.players.get(pid)
        return bool(p and p.is_alive())

    def current_turn_player_id(self) -> Optional[str]:
        """현재 차례 플레이어 ID. round_order 활성 시: 현재 actor 가 player 면 그 id, 몬스터면 None.
        round_order 비활성(legacy) 시: turn_order 의 현재 인덱스 player_id."""
        # 🆕 Phase 3 — round_order 활성 시 그쪽을 우선
        actor = self.current_actor()
        if actor:
            return actor.get("id") if actor.get("kind") == "player" else None
        # legacy 폴백
        if not self.turn_order:
            return None
        return self.turn_order[self.current_turn_index % len(self.turn_order)]

    def advance_turn(self) -> bool:
        """턴을 다음 actor 로 넘김. 라운드 완료 시 True.
        🆕 Phase 3: round_order 활성 시 advance_actor 위임 — 몬스터 차례도 포함.
        🆕 사망(HP 0) actor 는 자동 스킵."""
        # round_order 활성 시 새 시스템 사용
        if self.round_order:
            return self.advance_actor()
        # legacy 폴백 — turn_order 만 사용 (Phase 3 비활성 케이스)
        if not self.turn_order:
            return False
        n = len(self.turn_order)
        prev = self.current_turn_index
        for step in range(1, n + 1):
            new_idx = (self.current_turn_index + step) % n
            pid = self.turn_order[new_idx]
            if self._is_pid_alive(pid):
                self.current_turn_index = new_idx
                wrapped = (prev + step) >= n
                return wrapped and new_idx <= prev
        return False

    def all_alive_players(self) -> List["Player"]:
        """🆕 현재 살아있는 (HP > 0) 플레이어 목록. dormant 제외."""
        return [p for p in self.players.values() if p.is_alive()]

    # ── 🆕 Phase 3 — Initiative 기반 라운드 시스템 ─────────
    # 핵심 원칙:
    #   1) round_order 가 있으면 그것을 우선 사용. 없으면 legacy turn_order 로 폴백 (호환성).
    #   2) 라운드가 끝나거나 round_order 가 비면 start_new_round 가 새로 굴림.
    #   3) 죽은 actor 는 자동 스킵 (round_order 자체는 유지).
    #   4) current_turn_player_id 와 advance_turn 같은 기존 API 는 의미 그대로 유지 (player 만 가리킴).

    def is_actor_alive(self, actor: dict) -> bool:
        """round_order 의 한 항목이 살아있는지. monster HP 0 도 dead."""
        if not actor:
            return False
        if actor.get("kind") == "player":
            p = self.players.get(actor.get("id", ""))
            return bool(p and p.is_alive())
        if actor.get("kind") == "monster":
            m = self.monsters.get(actor.get("id", ""))
            return bool(m and m.hp > 0)
        return False

    def current_actor(self) -> Optional[dict]:
        """현재 차례의 행동자. round_order 비어있으면 None."""
        if not self.round_order:
            return None
        if 0 <= self.round_idx < len(self.round_order):
            return self.round_order[self.round_idx]
        return None

    def start_new_round(self) -> None:
        """새 라운드 — initiative 재굴림 + round_idx 0 + round_number +1.
        살아있는 플레이어와 몬스터가 둘 다 없으면 round_order 는 빈 리스트."""
        self.round_order = self.roll_initiative()
        self.round_idx = 0
        self.round_number += 1

    def advance_actor(self) -> bool:
        """현재 actor 처리 끝 → 다음 actor 로. 죽은 actor 자동 스킵.
        round_order 끝 도달 시 start_new_round 호출 + True 반환 (라운드 완료).
        round_order 비어있으면 즉시 새 라운드 시작 + True."""
        if not self.round_order:
            self.start_new_round()
            return True
        # 다음 살아있는 actor 까지 round_idx 전진
        n = len(self.round_order)
        i = self.round_idx + 1
        while i < n:
            if self.is_actor_alive(self.round_order[i]):
                self.round_idx = i
                return False  # 라운드 진행 중
            i += 1
        # 라운드 끝 — 새 라운드
        self.start_new_round()
        return True

    def ensure_round_started(self) -> None:
        """게임 시작 시 / 첫 액션 전에 호출 — round_order 비어있으면 굴림.
        살아있는 플레이어가 있어야 의미 있음 (TPK 시엔 호출하지 말 것)."""
        if not self.round_order:
            self.start_new_round()

    # ── 🆕 Initiative 시스템 (Phase 2) ─────────────
    # DND 5e 표준: initiative = d20 + DEX modifier. 매 라운드 시작 시 한 번 굴려 모든 행동자 정렬.
    # 같은 값이면 plyaer > monster 우선 (드라마틱 효과 + 플레이어 입력 기다림 자연스러움).
    def roll_initiative(self) -> List[dict]:
        """라운드 시작 시점의 행동 순서 결정. 살아있는 플레이어 + 살아있는 몬스터 모두 포함.
        반환: [{kind, id, name, initiative, dex_or_speed}] 내림차순 정렬.
        kind = 'player' | 'monster'."""
        order: List[dict] = []
        for p in self.players.values():
            if not p.is_alive():
                continue
            mod = ability_modifier(p.dexterity)
            roll = random.randint(1, 20) + mod
            order.append({
                "kind": "player",
                "id": p.player_id,
                "name": p.name,
                "initiative": roll,
                "dex_or_speed": p.dexterity,
            })
        for m in self.monsters.values():
            if m.hp <= 0:
                continue
            spd = m.speed
            mod = ability_modifier(spd)
            roll = random.randint(1, 20) + mod
            order.append({
                "kind": "monster",
                "id": m.name,    # 몬스터는 name 이 ID
                "name": m.name,
                "initiative": roll,
                "dex_or_speed": spd,
            })
        # 내림차순. 동률 시 player 우선.
        order.sort(key=lambda x: (-x["initiative"], 0 if x["kind"] == "player" else 1))
        return order

    def is_tpk(self) -> bool:
        """🆕 파티 전멸 — 등록된 플레이어가 있고 모두 HP 0 인 상태. 빈 방은 TPK 아님."""
        if not self.players:
            return False
        return all(not p.is_alive() for p in self.players.values())

    def find_rescue_items(self) -> List[Tuple[str, str, str]]:
        """🆕 TPK 시 구원 가능한 아이템 검색. 반환: [(player_name, item_name, effect_or_empty)].
        검색 키워드: 이름·효과에 '구원/부활/기적/소생/생명/빛/성수/회생' 포함.
        효과가 미공개(None)인 신비한 아이템도 포함 — DM 이 서사로 풀어낼 여지를 줌."""
        kw = ("구원", "부활", "기적", "소생", "생명", "빛", "성수", "회생", "재생")
        out: List[Tuple[str, str, str]] = []
        for p in self.players.values():
            for it in p.inventory:
                name = (it.get("name") or "").strip()
                effect = (it.get("effect") or "").strip()
                # 1) 이름 또는 효과에 키워드가 들어있으면 후보
                # 2) 효과가 미공개(None/빈) 인 아이템도 "혹시?" 후보로 추가
                hit = any(k in name for k in kw) or any(k in effect for k in kw)
                mystery = (it.get("effect") in (None, ""))
                if hit or mystery:
                    out.append((p.name, name, effect))
        return out

    async def broadcast(self, message: dict, exclude: Optional[str] = None):
        # players 가 포함된 메시지엔 monsters 도 자동 동봉 (카드 렌더 동기화).
        # 개별 브로드캐스트마다 monsters 필드를 수동 추가하지 않아도 되도록 여기서 일괄 주입.
        if "players" in message and "monsters" not in message:
            message = dict(message)
            message["monsters"] = [m.to_dict() for m in self.monsters.values()]
        # 플레이어
        dead = []
        for pid, ws in self.connections.items():
            if pid == exclude:
                continue
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(pid)
        for pid in dead:
            self.connections.pop(pid, None)
        # 🆕 관전자 (모든 브로드캐스트 수신)
        dead_spec = []
        for sid, info in self.spectators.items():
            if sid == exclude:
                continue
            try:
                await info["ws"].send_json(message)
            except Exception:
                dead_spec.append(sid)
        for sid in dead_spec:
            self.spectators.pop(sid, None)

    def spectators_summary(self) -> List[dict]:
        return [{"spectator_id": sid, "name": info.get("name", "관전자")}
                for sid, info in self.spectators.items()]

    # ── 휴면 캐릭터 (dormant) 관리 ─────────────
    def dormant_available(self) -> List[dict]:
        """2분 이상 비어있어 takeover 가능한 휴면 캐릭터 목록."""
        now = time.time()
        out = []
        for pid, info in self.dormant.items():
            elapsed = now - info.get("departed_at", now)
            if elapsed >= DORMANT_TAKEOVER_DELAY_SEC:
                p: Player = info["player"]
                out.append({
                    "player_id": pid,
                    "name": p.name,
                    "character_class": p.character_class,
                    "race": p.race,
                    "race_emoji": p.race_emoji,
                    "emoji": p.emoji,
                    "level": p.level,
                    "hp": p.hp,
                    "max_hp": p.max_hp,
                    "mp": p.mp,
                    "max_mp": p.max_mp,
                    "portrait_url": p.effective_portrait(),
                    "inventory": list(p.inventory),
                    "equipped": dict(p.equipped),
                    "departed_at": info["departed_at"],
                    "seconds_away": int(elapsed),
                })
        return out

    def _move_to_dormant(self, player_id: str):
        """커넥션 끊긴 플레이어를 휴면 상태로 이동. 다음 장면에서 자리 비움으로 처리."""
        player = self.players.pop(player_id, None)
        if not player:
            return None
        self.connections.pop(player_id, None)
        self.remove_from_turn_order(player_id)
        # _room_id 는 유지 — dormant 카드에서도 초상화 URL 을 만들어야 하기 때문.
        self.dormant[player_id] = {
            "player": player,
            "departed_at": time.time(),
        }
        return player

    def restore_from_dormant(self, dormant_pid: str, new_player_id: str) -> Optional[Player]:
        """휴면 캐릭터를 새 접속자 id 에 바인딩해 복귀. 장비/인벤/레벨 전부 보존."""
        info = self.dormant.pop(dormant_pid, None)
        if not info:
            return None
        player: Player = info["player"]
        # player_id 교체 (새 세션용)
        player.player_id = new_player_id
        player.is_ready = False
        player._room_id = self.room_id  # 방어적 — 혹시 누락됐을 경우
        self.players[new_player_id] = player
        self.add_to_turn_order(new_player_id)
        return player

    async def announce_departure(self, player: Player):
        """퇴장 서사시를 LLM 으로 생성해 브로드캐스트. 실패 시 폴백 문장 사용."""
        fallback = (
            f"\n\n*— {player.name}은(는) 잠시 사정이 생겨 일행을 떠났다. "
            "파티는 잠시 공허한 자리를 바라본다. —*\n\n"
        )
        text = fallback
        try:
            prompt = (
                f"[시스템: {player.name}({player.race} {player.character_class}, Lv{player.level})이 "
                "잠시 사정이 생겨 파티를 떠났다는 짧은 간주를 2~3문장으로 묘사해라. "
                "서사시적이고 극적으로, 다시 돌아올 여지를 남겨라. 시간대 태그는 생략하고 본문만.]"
            )
            async with self.lock:
                self.messages.append({"role": "user", "content": prompt})
                text = await llm_complete(build_system_prompt(self.scenario_id), self._llm_slice(), max_tokens=300)
                text = _sanitize_dm_text(text)  # 🆕 수치 + 수인% + 한자 사후 정리
                self.messages.append({"role": "assistant", "content": text})
                self._trim_messages()
        except Exception as e:
            print(f"[announce_departure] LLM 실패 → 폴백 사용: {e}")
            text = fallback
        try:
            await self.broadcast({
                "type": "dm_interlude",
                "kind": "departure",
                "text": text,
                "player_name": player.name,
            })
        except Exception:
            pass

    async def announce_return(self, player: Player, seconds_away: int, is_takeover: bool):
        """복귀/승계 서사시. seconds_away 로 톤 조절."""
        # 경과 시간 → 한국어 톤 키워드
        if seconds_away < 300:
            mood = "잠시 자리를 비웠다 다시 합류하는 가벼운 톤"
        elif seconds_away < 1800:
            mood = "한동안 행방이 묘연했던 동료가 숨을 헐떡이며 돌아오는 톤"
        elif seconds_away < 7200:
            mood = "오래 걸린 여정 끝에 흙먼지를 털며 귀환한 느낌"
        else:
            mood = "긴 시간 흩어져 있던 영웅이 전설처럼 재등장하는 묵직한 톤"
        who = "다른 영웅의 모습을 빌려 합류한 새 동료" if is_takeover else "본인"
        prompt = (
            f"[시스템: {player.name}({player.race} {player.character_class}, Lv{player.level})이 "
            f"파티에 다시 합류한다. 경과: 약 {seconds_away}초 — {mood}. "
            f"이 인물은 {who}이다. 2~3문장으로 자연스럽고 스무스한 등장 장면을 묘사해라. "
            "시간대 태그 생략, 본문만.]"
        )
        fallback = (
            f"\n\n*— {player.name}이(가) 마침 좋은 타이밍에 파티에 다시 합류했다. —*\n\n"
        )
        text = fallback
        try:
            async with self.lock:
                self.messages.append({"role": "user", "content": prompt})
                text = await llm_complete(build_system_prompt(self.scenario_id), self._llm_slice(), max_tokens=300)
                text = _sanitize_dm_text(text)  # 🆕 수치 + 수인% + 한자 사후 정리
                self.messages.append({"role": "assistant", "content": text})
                self._trim_messages()
        except Exception as e:
            print(f"[announce_return] LLM 실패 → 폴백 사용: {e}")
            text = fallback
        try:
            await self.broadcast({
                "type": "dm_interlude",
                "kind": "return" if not is_takeover else "takeover",
                "text": text,
                "player_name": player.name,
            })
        except Exception:
            pass

    @staticmethod
    def _race_label(p: "Player") -> str:
        """DM 프롬프트용 종족 라벨. 수인은 동물·비율 까지 포함해 서사 반영 가능하게."""
        if p.race != "수인" or not p.race_animal:
            return p.race
        r = p.race_ratio if p.race_ratio is not None else 50
        bucket = "인간형" if r <= 33 else ("반수인" if r <= 66 else "수형")
        return f"수인({p.race_animal}·{bucket}·{r}%)"

    def _players_summary(self) -> str:
        lines = []
        for p in self.players.values():
            # equipped 는 이제 {slot: {name, effect}} 딕트. 이름만 뽑아 요약.
            eq_parts = []
            for slot_name in ("weapon", "armor", "accessory"):
                slot = p.equipped.get(slot_name) or {}
                if isinstance(slot, dict):
                    nm = slot.get("name", "")
                elif isinstance(slot, str):
                    nm = slot
                else:
                    nm = ""
                if nm:
                    eq_parts.append(nm)
            eq_str = f", 장착: {' / '.join(eq_parts)}" if eq_parts else ""
            # 인벤토리는 이제 [{name, effect}, ...] — 이름만 요약에 노출 (효과는 캐릭터 패널에서)
            inv_names = [it.get("name", "") for it in p.inventory[-3:] if it.get("name")]
            inv_str = f", 소지: {', '.join(inv_names)}" if inv_names else ""
            # 🆕 6 ability 요약 — 판정·서사에 활용. 매력은 고정 표시.
            ab_str = (
                f", [STR {p.strength}, INT {p.intelligence}, WIS {p.wisdom}, "
                f"DEX {p.dexterity}, CHA {p.charisma}, CON {p.constitution}]"
            )
            lines.append(
                f"- {p.name} ({self._race_label(p)} {p.character_class}, Lv{p.level}, "
                f"HP:{p.hp}/{p.max_hp}, MP:{p.mp}/{p.max_mp}, "
                f"공격:{p.attack}, 방어:{p.defense}, 골드:{p.gold}{ab_str}{eq_str}{inv_str})"
            )
        # 🆕 파티 인원·평균 레벨 헤더 — DM 이 적 강도/수를 인원에 맞게 스케일링하도록 인지시킴.
        n = len(self.players)
        avg_lv = sum(p.level for p in self.players.values()) / n if n else 0
        day_str = f", {self.day}일차" if self.day > 1 else ""
        header = f"[파티 {n}명 · 평균 Lv{avg_lv:.1f}{day_str}]\n"
        return header + "\n".join(lines)

    def _trim_messages(self):
        if len(self.messages) > MESSAGE_HISTORY_CAP:
            self.messages = self.messages[-MESSAGE_HISTORY_CAP:]

    def _maybe_update_time(self, text: str):
        """시간 태그 파싱 + 날짜 래핑.
        새 ordinal 이 현재보다 작으면 **역행이 아니라 '다음 날로 넘어간 것'** 으로 간주해 day+1.
        → 심야 → 새벽 전이가 영원히 막히던 버그 해소."""
        t = parse_time_tag(text)
        if not t:
            return
        if self.current_time:
            prev_ord = self.current_time.get("ordinal", -1)
            new_ord = t.get("ordinal", -1)
            if new_ord >= 0 and prev_ord >= 0 and new_ord < prev_ord:
                self.day += 1
        t["day"] = self.day
        self.current_time = t

    def _parse_all_tags(self, text: str, tick_statuses: bool = True,
                        acting_player_id: Optional[str] = None) -> dict:
        """HP/MP/XP/아이템/아이템효과/시간/DM주사위/버프 태그를 한 번에 파싱하고 결과 요약 반환.
        tick_statuses=True 이고 acting_player_id 가 주어지면 **행동 당사자 1명의 상태만** tick 한다.
        (예전: 파티 전원 tick → 4인 파티에서 '3턴 버프' 가 1라운드도 못 버팀.
         지금: 본인 행동할 때만 -1 이므로 '3턴 = 본인 차례 3번' 으로 직관적.)
        새로 걸린 효과는 이번 턴 tick 면제 (아래서 새 태그 적용이 tick 뒤에 일어남)."""
        expired_statuses: List[dict] = []
        # 🆕 사망 전환 정확 감지 — 파싱 전 살아있던 사람을 스냅샷 떠두고, 파싱 후 비교.
        # 이전 방식(hp_affected 만 비교) 은 0→0 같은 무변화 케이스도 포착해 오토스트 유발.
        was_alive = {pid: p.is_alive() for pid, p in self.players.items()}
        if tick_statuses and acting_player_id:
            acting = self.players.get(acting_player_id)
            if acting:
                expired_statuses.extend(acting.tick_statuses())
        hp_affected = parse_and_apply_hp(text, self.players)
        mp_affected = parse_and_apply_mp(text, self.players)
        gold_events = parse_and_apply_gold(text, self.players)   # [{name, gold, delta}]
        xp_events = parse_and_apply_xp(text, self.players, acting_player_id)  # [{name, amount, new_level, gains}]
        items = parse_and_apply_items(text, self.players)        # [{name, item, effect, quantity, kind, slot, auto_equipped, replaced}]
        effects = parse_and_reveal_item_effects(text, self.players)  # [(name, item, effect)]
        equip_effects = parse_and_reveal_equip_effects(text, self.players)  # [(name, equip, effect)]
        uses = parse_and_use_items(text, self.players)           # [(name, item, used, remaining)]
        unequipped = parse_and_unequip(text, self.players)       # [(name, slot, prev_name)]
        statuses_applied = parse_and_apply_statuses(text, self.players)  # [{player_name, kind, name, turns, effect}]
        statuses_cleared = parse_and_clear_statuses(text, self.players)  # [{player_name, name}]
        die_max = {"d4": 4, "d6": 6, "d8": 8, "d10": 10, "d12": 12, "d20": 20, "d100": 100}
        dm_dice = [
            {"die": die, "result": result, "max": die_max[die]}
            for die, result in parse_dm_dice(text)
        ]
        monster_events = parse_and_apply_monsters(text, self.monsters, acting_player_id)
        # 처치된 몬스터에 대해 자동 XP 분배 (처치자 + 어시스트). 이전엔 DM 이 [XP +N] 안 찍으면 0 이었음.
        kill_xp_events = self._distribute_kill_xp(monster_events)
        # 🆕 캠페인 종료 태그 감지 — DM 이 아크 엔딩에 도달하면 [캠페인 종료: 분기키] 를 찍음.
        campaign_ending = None
        m = CAMPAIGN_END_PATTERN.search(text)
        if m:
            branch_key = m.group(1).strip()
            sc = SCENARIOS.get(self.scenario_id) or {}
            branches = (sc.get("arc") or {}).get("branches") or {}
            campaign_ending = {
                "branch": branch_key,
                "branch_known": branch_key in branches,
                "description": branches.get(branch_key, ""),
                "scenario_id": self.scenario_id,
                "scenario_name": sc.get("name", ""),
                "scenario_emoji": sc.get("emoji", ""),
            }
            # 방을 "종료 상태" 로 표시해 후속 액션 막을 수도 있으나 지금은 정보만 전달.
            # 서버 상태 변경은 최소화 — 유저가 새 방 만들어 새 캠페인 시작하는 흐름.
        # 새로 걸린 몬스터 디버프의 DOT 는 이번 응답엔 적용 안 함 — round_complete 시 tick.
        self._maybe_update_time(text)
        # 🆕 사망 전환 정확 감지 — 파싱 전 살아있다 → 파싱 후 사망 인 사람만.
        newly_dead = [
            p.name for pid, p in self.players.items()
            if was_alive.get(pid, False) and not p.is_alive()
        ]
        return {
            "hp_affected": hp_affected,
            "mp_affected": mp_affected,
            "gold_events": gold_events,
            "xp_events": xp_events + kill_xp_events,  # 수동 + 자동 처치 XP 둘 다 노출
            "items": items,  # parse_and_apply_items 가 이미 dict 리스트로 반환
            "item_effects": [{"name": n, "item": it, "effect": ef} for n, it, ef in effects],
            "item_uses": [{"name": n, "item": it, "used": u, "remaining": r} for n, it, u, r in uses],
            "unequipped": [{"name": n, "slot": s, "prev": p} for n, s, p in unequipped],
            "equip_effects": [{"name": n, "equip": e, "effect": ef} for n, e, ef in equip_effects],
            "dm_dice": dm_dice,
            "monster_events": monster_events,
            "statuses_applied": statuses_applied,
            "statuses_expired": expired_statuses,
            "statuses_cleared": statuses_cleared,
            "campaign_ending": campaign_ending,
            "newly_dead": newly_dead,
        }

    def _distribute_kill_xp(self, monster_events: List[dict]) -> List[dict]:
        """defeated 이벤트 → 처치자/어시스트에게 자동 XP. 이벤트는 xp_events 와 같은 모양으로 반환.
        처치 XP = 12 + max_hp//4 (HP 가 큰 적일수록 보상 큼, clamp 12~80).
        어시스트 XP = 처치 XP 의 1/3 (clamp 4~30)."""
        out: List[dict] = []
        for ev in monster_events:
            if ev.get("kind") != "defeated":
                continue
            attackers = ev.get("attackers") or []
            if not attackers:
                continue
            max_hp = int(ev.get("max_hp") or 1)
            kill_xp = max(12, min(80, 12 + max_hp // 4))
            assist_xp = max(4, min(30, kill_xp // 3))
            killer_id = attackers[-1]
            for pid in attackers:
                p = self.players.get(pid)
                if not p:
                    continue
                amount = kill_xp if pid == killer_id else assist_xp
                lvl = p.grant_xp(amount)
                out.append({
                    "name": p.name,
                    "amount": amount,
                    "granted": amount,
                    "kind": "kill" if pid == killer_id else "assist",
                    "monster": ev.get("name"),
                    "new_level": lvl["new_level"] if lvl else None,
                    "gains": lvl["gains"] if lvl else None,
                })
        return out

    def tick_monsters_round(self) -> List[dict]:
        """라운드 종료 시 호출 — 모든 살아있는 몬스터의 status_effects 를 한 번씩 tick.
        DOT 로 죽으면 그 시점에 마지막 attacker 가 처치자로 XP 분배까지 마무리.
        반환: round_summary 이벤트용 [{kind: 'tick'|'expired'|'defeated', ...}]."""
        events: List[dict] = []
        # dict 변경 방지를 위해 사본 순회
        for name, monster in list(self.monsters.items()):
            if monster.hp <= 0:
                continue
            expired, dot_dmg = monster.tick_statuses()
            if dot_dmg > 0:
                events.append({
                    "kind": "tick",
                    "name": monster.name,
                    "damage": dot_dmg,
                    "hp": monster.hp,
                    "max_hp": monster.max_hp,
                })
            for e in expired:
                events.append({"kind": "status_expired", **e})
            if monster.hp <= 0:
                # DOT 로 죽음 — 마지막 attacker 가 처치자.
                events.append({
                    "kind": "defeated",
                    "name": monster.name,
                    "max_hp": monster.max_hp,
                    "attackers": list(monster.attackers),
                    "by_dot": True,
                })
                self.monsters.pop(name, None)
        # DOT 처치 XP 분배 (위 이벤트 중 defeated 만 골라서)
        events.extend(self._distribute_kill_xp(events))
        return events

    def cooldown_remaining(self, player_id: str) -> float:
        """플레이어의 다음 행동까지 남은 쿨다운(초). 0이면 행동 가능."""
        last = self.last_action_at.get(player_id, 0.0)
        elapsed = time.time() - last
        return max(0.0, ACTION_COOLDOWN_SEC - elapsed)

    def _llm_slice(self) -> List[dict]:
        """LLM에 보낼 최근 메시지. Anthropic 규칙 준수:
        (1) 첫 메시지는 반드시 user 역할
        (2) 마지막 메시지도 user (prefill 미지원 모델 방어)
        """
        msgs = list(self.messages[-LLM_CONTEXT_WINDOW:])
        while msgs and msgs[0].get("role") != "user":
            msgs.pop(0)
        while msgs and msgs[-1].get("role") != "user":
            msgs.pop()
        return msgs

    async def get_dm_intro(self) -> str:
        sc = SCENARIOS.get(self.scenario_id) or SCENARIOS[DEFAULT_SCENARIO_ID]
        prompt = (
            f"파티가 모였습니다:\n{self._players_summary()}\n\n"
            f"모험을 시작하세요. {sc['intro_hook']} "
            "극적인 오프닝 장면을 묘사해주세요. "
            "반드시 맨 첫 줄에 시간대 태그를 넣으세요."
        )
        async with self.lock:
            self.messages = [{"role": "user", "content": prompt}]
            # 인트로는 액션보다 여유 (700) — 오프닝은 분위기 잡는 긴 묘사 필요.
            # llm_complete 가 잘리면 자동 종결 경계 트림.
            text = await llm_complete(build_system_prompt(self.scenario_id), self._llm_slice(), max_tokens=700)
            # 🆕 인트로에도 사후 정리 (수치 + 수인% + 한자)
            text = _sanitize_dm_text(text)
            self.messages.append({"role": "assistant", "content": text})
            self._parse_all_tags(text, tick_statuses=False)
            self._trim_messages()
        return text

    async def process_action(self, player_id: str, action: str) -> Tuple[str, dict]:
        """행동 처리. (DM 응답 텍스트, 태그 파싱 결과) 반환.
        **락 안에서 append + LLM 호출 모두 처리** — race 방지."""
        player = self.players.get(player_id)
        player_name = player.name if player else "알 수 없음"
        self.last_action_at[player_id] = time.time()

        # 시스템 메모 (그림 공개 등) 수집 — 전체 파티 + 이번 행동자.
        note_parts: List[str] = []
        for p in self.players.values():
            if p.pending_notes:
                note_parts.extend(p.pending_notes)
                p.pending_notes = []
        notes_block = ("\n\n[DM용 시스템 메모]\n" + "\n".join(note_parts)) if note_parts else ""

        content = (
            f"[{player_name}의 행동]: {action}\n\n"
            f"현재 파티:\n{self._players_summary()}"
            f"{notes_block}"
        )

        async with self.lock:
            self.messages.append({"role": "user", "content": content})
            # 액션 응답 max_tokens — 시스템 프롬프트가 350**자** 제한이지만,
            # 한국어는 1글자당 약 1.4~1.8 토큰 (특히 Kimi 토크나이저). 350자 ≈ 490~630 토큰.
            # 600 으로 잡아 과생성 여유 확보 + llm_complete 가 잘려도 종결 경계로 트림.
            text = await llm_complete(
                build_system_prompt(self.scenario_id), self._llm_slice(), max_tokens=600
            )
            # 🆕 LLM 다국어/숫자/% 누수 사후 제거 — 태그 파싱 *전*에 적용해 파서가 보는 본문도 깔끔.
            # 잡는 패턴: 'STR 16 의 압도적인', '70% 수인화된', '试图하지만' 등
            text = _sanitize_dm_text(text)
            self.messages.append({"role": "assistant", "content": text})
            tag_events = self._parse_all_tags(text, acting_player_id=player_id)
            self._trim_messages()

        return text, tag_events

    async def process_monster_turn(self, monster_name: str) -> Tuple[Optional[str], dict]:
        """🆕 Phase 3 — 몬스터 차례에 DM 호출해서 자동 행동 생성.
        반환: (서사 텍스트 or None, tag_events). HP 0 인 몬스터/없는 이름이면 (None, {}).

        설계:
          - 몬스터의 HP/속도/상태를 시스템 프롬프트에 묶어 LLM 에 전달.
          - DM 이 1~2 문장으로 행동·대사·공격 묘사 + [이름 HP: A → B] 같은 태그로 결과 반영.
          - 액션 max_tokens 보다 짧게 (350) — 몬스터 차례는 압축된 비트.
        """
        monster = self.monsters.get(monster_name)
        if not monster or monster.hp <= 0:
            return None, {}
        alive = self.all_alive_players()
        if not alive:
            # TPK 상태 — 적이 행동할 의미 없음. 빈 응답으로 끝.
            return None, {}
        target_names = ", ".join(p.name for p in alive)
        # 적 본인의 상태 요약 — DOT 디버프·HP 비율 등 행동에 영향.
        st_summary = ""
        if monster.status_effects:
            st_summary = " | 상태: " + ", ".join(
                f"{s.get('name', '?')}({s.get('turns_remaining', '?')}턴)"
                for s in monster.status_effects
            )
        prompt = (
            f"[시스템: 몬스터 행동 차례 — {monster.name} (HP {monster.hp}/{monster.max_hp}, "
            f"속도 {monster.speed}{st_summary}). "
            f"가능한 표적: {target_names}. "
            f"이 적이 1~2 문장으로 행동·대사·공격을 묘사해라. "
            f"공격이라면 명중 판정 [🎲DM d20: X] (보통 d20 + 적 속도 modifier vs 표적 DEX modifier 또는 방어), "
            f"명중 시 `[표적이름 HP: A → B]` 태그로 피해 적용. "
            f"적이 자기 차례를 그냥 보내는 건 금지 — 의미있는 행동·이동·주문·대사 중 하나 필수. "
            f"전투 종료 직후거나 도망 적합한 상황이면 `[적 퇴장: {monster.name}]` 도 가능.]"
        )
        async with self.lock:
            self.messages.append({"role": "user", "content": prompt})
            text = await llm_complete(
                build_system_prompt(self.scenario_id),
                self._llm_slice(),
                max_tokens=350
            )
            # 🆕 몬스터 차례 서사도 동일 사후 정리 (수치/수인%/한자).
            text = _sanitize_dm_text(text)
            self.messages.append({"role": "assistant", "content": text})
            # acting_player_id 없음 — 플레이어 status tick 안 함 (몬스터 차례라).
            tag_events = self._parse_all_tags(text, tick_statuses=False)
            self._trim_messages()
        return text, tag_events


rooms: Dict[str, GameRoom] = {}


# ── 디스크 영속화 (방 상태 JSON 저장) ─────────
SAVE_DIR = Path(__file__).parent / "saves"
SAVE_DIR.mkdir(exist_ok=True)


async def save_room(room: "GameRoom"):
    """방 상태를 JSON 으로 디스크에 비동기 저장.
    실패해도 게임은 계속 돌아감 — 치명적이지 않음."""
    try:
        path = SAVE_DIR / f"{room.room_id}.json"
        data = room.to_save_dict()

        def _write():
            tmp = path.with_suffix(".json.tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=1)
            # 원자적 교체 — 쓰기 중 서버가 죽어도 이전 저장본 보존
            tmp.replace(path)
        await asyncio.to_thread(_write)
    except Exception as e:
        print(f"[SAVE FAIL] {room.room_id}: {type(e).__name__}: {e}")


def delete_save(room_id: str):
    """방이 해산되면 저장 파일도 제거."""
    try:
        p = SAVE_DIR / f"{room_id}.json"
        if p.exists():
            p.unlink()
    except Exception as e:
        print(f"[DEL SAVE FAIL] {room_id}: {e}")


def load_all_saves():
    """서버 기동 시 saves/*.json 을 rooms 딕트로 복원.
    sync 함수 — 기동 1회만 호출."""
    count = 0
    for p in sorted(SAVE_DIR.glob("*.json")):
        try:
            with open(p, "r", encoding="utf-8") as f:
                d = json.load(f)
            room = GameRoom.from_save_dict(d)
            rooms[room.room_id] = room
            count += 1
        except Exception as e:
            print(f"[LOAD FAIL] {p.name}: {type(e).__name__}: {e}")
    if count:
        print(f"[SAVE] {count}개 방 복원됨 (코드: {', '.join(rooms.keys())})")
    else:
        print("[SAVE] 저장된 방 없음 (새로 시작)")


# 기동 시 전체 저장본 로드
load_all_saves()


def _new_room_code() -> str:
    """충돌 없는 새 방 코드 생성."""
    for _ in range(ROOM_CODE_MAX_RETRIES):
        code = str(uuid.uuid4())[:6].upper()
        if code not in rooms:
            return code
    # 극단적으로 드문 경우 — 더 긴 코드로 폴백
    return str(uuid.uuid4())[:8].upper()


@app.get("/", response_class=HTMLResponse)
async def index():
    # 기동 시각을 캐시버스터로 주입. 파일은 런타임에 다시 읽어서 HTML 수정 시 재시작 없이 반영.
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    # ?v=숫자 / ?v=토큰 형태 전부 STATIC_VERSION으로 치환
    html = re.sub(r"\?v=[\w\.]+", f"?v={STATIC_VERSION}", html)
    return HTMLResponse(html)


@app.get("/scenarios")
async def scenarios_catalog():
    """방 만들기 화면에서 시나리오 선택지를 채울 때 쓰는 카탈로그.
    각 항목: {id, name, emoji, summary}. setting 같은 DM 전용 정보는 포함 안 됨."""
    return {"scenarios": _all_scenarios_public(), "default": DEFAULT_SCENARIO_ID}


@app.get("/portrait/{room_id}/{player_id}")
async def portrait(room_id: str, player_id: str):
    """유저가 그린 커스텀 초상화를 **URL 로** 서빙.
    예전에는 data URL (최대 1.4 MB) 을 매 브로드캐스트에 포함 → 4인 파티면 DM 응답마다 ~5 MB WS payload.
    이제 브로드캐스트 payload 에는 이 라우트 URL 만 실리고 실제 이미지는 여기서 1회만 내려간다."""
    room = rooms.get(room_id.upper())
    if not room:
        raise HTTPException(status_code=404, detail="room not found")
    player = room.players.get(player_id)
    if not player:
        info = room.dormant.get(player_id)
        player = info.get("player") if isinstance(info, dict) else None
    if not player:
        raise HTTPException(status_code=404, detail="player not found")
    if not player.custom_portrait:
        # 기본 AI 초상화로 리다이렉트 — pollinations URL
        return RedirectResponse(url=player.portrait_url, status_code=302)
    data_url = player.custom_portrait
    prefix, _, b64data = data_url.partition(",")
    mime = "image/jpeg"
    if "image/png" in prefix:
        mime = "image/png"
    elif "image/webp" in prefix:
        mime = "image/webp"
    try:
        data = base64.b64decode(b64data)
    except Exception:
        raise HTTPException(status_code=500, detail="corrupted portrait data")
    return Response(
        content=data,
        media_type=mime,
        headers={"Cache-Control": "public, max-age=86400"},
    )


async def _send_error(ws: WebSocket, message: str):
    try:
        await ws.send_json({"type": "error", "message": message})
    except Exception:
        pass


def _dormant_summary(room: "GameRoom") -> List[dict]:
    """방의 휴면 캐릭터를 takeover 가능 여부와 함께 요약 — 프론트에 보내기 위함.
    만료(24h) 항목이 있으면 이 시점에 정리하고 목록에서 제외."""
    room.expire_dormant()
    now = time.time()
    out = []
    for pid, info in room.dormant.items():
        p = info.get("player")
        if not isinstance(p, Player):
            continue
        departed_at = info.get("departed_at", now)
        elapsed = now - departed_at
        ready = elapsed >= DORMANT_TAKEOVER_DELAY_SEC
        out.append({
            "player_id": pid,
            "name": p.name,
            "race": p.race,
            "race_animal": p.race_animal,   # 🆕 수인 서브 정보 (takeover 카드에서 표시)
            "race_ratio": p.race_ratio,
            "character_class": p.character_class,
            "level": p.level,
            "portrait_url": p.effective_portrait(),
            "hp": p.hp, "max_hp": p.max_hp,
            "mp": p.mp, "max_mp": p.max_mp,
            "takeover_ready": ready,
            "elapsed_sec": int(elapsed),
            "unlock_in_sec": max(0, int(DORMANT_TAKEOVER_DELAY_SEC - elapsed)),
        })
    return out


def _pick_new_owner(room: "GameRoom", exclude_id: str) -> Optional[str]:
    """방장 이양 우선순위:
    (0) **현재 WS 연결이 살아있는** 플레이어만 후보 (끊긴 사람이 방장 되면 권한이 허공에 뜸).
    (1) 가장 강한 플레이어 (Lv 내림차순 → XP 내림차순)
    (2) 동률이면 가장 먼저 입장한 사람 (turn_order 기준)
    → 연결된 후보 자체가 없으면 None 반환 (호출측에서 owner_id = None 처리).
    """
    candidates = [
        p for p in room.players.values()
        if p.player_id != exclude_id and p.player_id in room.connections
    ]
    if not candidates:
        return None
    def join_idx(pid):
        try:
            return room.turn_order.index(pid)
        except ValueError:
            return 9999
    candidates.sort(key=lambda p: (-p.level, -p.xp, join_idx(p.player_id)))
    return candidates[0].player_id


async def _notify_owner_change(room: "GameRoom", new_owner_id: str):
    """새 방장에게 권한 알림 + 전원에게 방장 변경 공지."""
    new_owner = room.players.get(new_owner_id)
    if not new_owner:
        return
    # 새 방장에게 is_owner=True 전달
    ws = room.connections.get(new_owner_id)
    if ws:
        try:
            await ws.send_json({"type": "owner_granted"})
        except Exception:
            pass
    await room.broadcast({
        "type": "owner_changed",
        "new_owner_id": new_owner_id,
        "new_owner_name": new_owner.name,
    })


async def _transfer_owner_or_vacate(room: "GameRoom", exclude_id: str):
    """방장 이탈 시 공통 승계 로직.
    - 연결된 후보가 있으면 그 중 강자에게 이양 + 공지.
    - 후보가 없으면 owner_id=None 으로 남기고 `owner_vacant` 브로드캐스트.
      다음 입장·재입장 시점에 room.owner_id 가 None 이면 자동 위임."""
    new_owner_id = _pick_new_owner(room, exclude_id)
    if new_owner_id:
        room.owner_id = new_owner_id
        await _notify_owner_change(room, new_owner_id)
    else:
        room.owner_id = None
        try:
            await room.broadcast({"type": "owner_vacant"})
        except Exception:
            pass


async def _claim_vacant_owner(room: "GameRoom", candidate_id: str):
    """room.owner_id 가 None 일 때, 연결된 사람이 처음 들어오면 자동으로 방장 위임."""
    if room.owner_id is None and candidate_id in room.connections:
        room.owner_id = candidate_id
        await _notify_owner_change(room, candidate_id)


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    await websocket.accept()
    player_id: Optional[str] = None
    current_room: Optional[str] = None
    spectator_id: Optional[str] = None  # 🆕 관전자 모드 식별자

    try:
        while True:
            data = await websocket.receive_json()
            msg = data.get("type")

            if msg == "create_room":
                raw_race = data.get("race")
                chosen_race = raw_race if raw_race in RACES else None
                weapon_choice = data.get("weapon_choice")
                race_animal_in = data.get("race_animal")
                race_ratio_in = data.get("race_ratio")
                animal_ok, ratio_ok, err = validate_race_params(chosen_race, race_animal_in, race_ratio_in)
                if err:
                    await _send_error(websocket, err)
                    continue

                # 🆕 시나리오 선택 — 유효하지 않으면 기본값(볼카르). "random" 이면 무작위.
                raw_scenario = (data.get("scenario_id") or "").strip()
                if raw_scenario == "random":
                    chosen_scenario = random.choice(list(SCENARIOS.keys()))
                elif raw_scenario in SCENARIOS:
                    chosen_scenario = raw_scenario
                else:
                    chosen_scenario = DEFAULT_SCENARIO_ID

                player_id = player_id or str(uuid.uuid4())[:8]
                room_id = _new_room_code()
                room = GameRoom(room_id, scenario_id=chosen_scenario)
                rooms[room_id] = room
                current_room = room_id
                room.owner_id = player_id

                print(f"[CREATE_ROOM] name={data.get('player_name')!r} class={data.get('character_class')!r} "
                      f"race={chosen_race!r} animal={animal_ok!r} ratio={ratio_ok!r} "
                      f"scenario={chosen_scenario!r}")
                try:
                    player = Player(player_id, data["player_name"], data["character_class"],
                                    chosen_race, weapon_choice,
                                    race_animal=animal_ok, race_ratio=ratio_ok)
                except ValueError as e:
                    # Player 내부 최종 검증 실패 — 방 파기
                    rooms.pop(room_id, None)
                    current_room = None
                    await _send_error(websocket, str(e))
                    continue
                room.attach_player(player)
                room.connections[player_id] = websocket
                room.add_to_turn_order(player_id)

                await websocket.send_json({
                    "type": "room_created",
                    "room_id": room_id,
                    "player_id": player_id,
                    "is_owner": True,
                    "players": [p.to_dict() for p in room.players.values()],
                    "turn_player_id": room.current_turn_player_id(),
                    "narrative_log": list(room.narrative_log),
                    "dormant": _dormant_summary(room),
                    "scenario": _scenario_public(room.scenario_id),
                })
                await save_room(room)

            elif msg == "join_room":
                room_id = data["room_id"].upper().strip()
                if room_id not in rooms:
                    await _send_error(websocket, "방을 찾을 수 없습니다.")
                    continue

                room = rooms[room_id]

                # 🆕 takeover 가능한 휴면 캐릭터가 있으면 먼저 선택지를 보낸다.
                #    클라가 "이어서" 를 고르면 takeover_character 메시지로 후속 요청 보냄.
                #    "새 캐릭" 을 고르면 force_new_character 플래그로 다시 join_room 보냄.
                wants_new = bool(data.get("force_new_character"))
                dormants = room.dormant_available()
                if dormants and not wants_new:
                    await websocket.send_json({
                        "type": "dormant_choice",
                        "room_id": room_id,
                        "dormants": dormants,
                        "pending": {
                            "player_name": data.get("player_name", ""),
                            "character_class": data.get("character_class", "전사"),
                        },
                    })
                    # 클라 선택 올 때까지 대기 (다음 메시지에서 처리)
                    continue

                # 🆕 race: 유효하면 사용, 아니면 랜덤
                chosen_race = data.get("race")
                if chosen_race not in RACES:
                    chosen_race = None
                weapon_choice = data.get("weapon_choice")
                race_animal_in = data.get("race_animal")
                race_ratio_in = data.get("race_ratio")
                animal_ok, ratio_ok, err = validate_race_params(chosen_race, race_animal_in, race_ratio_in)
                if err:
                    await _send_error(websocket, err)
                    continue

                current_room = room_id
                player_id = player_id or str(uuid.uuid4())[:8]

                try:
                    player = Player(player_id, data["player_name"], data["character_class"],
                                    chosen_race, weapon_choice,
                                    race_animal=animal_ok, race_ratio=ratio_ok)
                except ValueError as e:
                    await _send_error(websocket, str(e))
                    continue
                # 🆕 게임이 이미 진행 중이면 사전 조정 단계 없이 바로 race 보정 적용 (대기실 거치지 못한 늦은 입장자).
                if room.started and not player.race_mod_applied:
                    player.apply_race_modifiers()
                room.attach_player(player)
                room.connections[player_id] = websocket
                room.add_to_turn_order(player_id)
                # 방장 공석 상태면 신규 입장자에게 자동 위임
                await _claim_vacant_owner(room, player_id)

                await websocket.send_json({
                    "type": "joined_room",
                    "room_id": room_id,
                    "player_id": player_id,
                    "is_owner": room.owner_id == player_id,
                    "players": [p.to_dict() for p in room.players.values()],
                    "started": room.started,
                    "turn_player_id": room.current_turn_player_id(),
                    "narrative_log": list(room.narrative_log),
                    "chat_log": room.chat_log[-30:],
                    "current_time": room.current_time,
                    "dormant": _dormant_summary(room),
                    "scenario": _scenario_public(room.scenario_id),
                    # 🆕 Phase 3
                    "round_order": list(room.round_order),
                    "round_idx": room.round_idx,
                    "round_number": room.round_number,
                    "current_actor": room.current_actor(),
                })
                await room.broadcast({
                    "type": "player_joined",
                    "player": player.to_dict(),
                    "players": [p.to_dict() for p in room.players.values()],
                    "turn_player_id": room.current_turn_player_id(),
                }, exclude=player_id)
                # 🆕 이미 게임이 시작된 방에 '새 캐릭' 으로 합류한 경우 DM 이 스무스하게 등장시킴
                if room.started:
                    asyncio.create_task(room.announce_return(player, 0, is_takeover=False))
                await save_room(room)

            elif msg == "join_as_spectator":
                # 🆕 관전자로 입장. 턴오더/플레이어 목록에 안 잡히지만 브로드캐스트는 모두 수신.
                room_id = str(data.get("room_id", "")).upper().strip()
                if not room_id or room_id not in rooms:
                    await _send_error(websocket, "방을 찾을 수 없습니다.")
                    continue
                room = rooms[room_id]
                current_room = room_id
                spectator_id = spectator_id or str(uuid.uuid4())[:8]
                spec_name = str(data.get("spectator_name", "")).strip()[:16] or f"관전자-{spectator_id[:4]}"
                room.spectators[spectator_id] = {"name": spec_name, "ws": websocket}

                await websocket.send_json({
                    "type": "joined_as_spectator",
                    "room_id": room_id,
                    "spectator_id": spectator_id,
                    "spectator_name": spec_name,
                    "players": [p.to_dict() for p in room.players.values()],
                    "started": room.started,
                    "current_time": room.current_time,
                    "chat_log": room.chat_log[-30:],
                    "turn_player_id": room.current_turn_player_id(),
                    "last_dm": next(
                        (m["content"] for m in reversed(room.messages)
                         if m.get("role") == "assistant"), None),
                    "spectator_count": len(room.spectators),
                })
                await room.broadcast({
                    "type": "spectator_joined",
                    "spectator_name": spec_name,
                    "spectator_count": len(room.spectators),
                }, exclude=spectator_id)

            elif msg == "rejoin_room":
                room_id = str(data.get("room_id", "")).upper().strip()
                req_pid = str(data.get("player_id", "")).strip()
                if not room_id or not req_pid or room_id not in rooms:
                    await websocket.send_json({"type": "rejoin_failed", "reason": "방 없음"})
                    continue
                room = rooms[room_id]

                # 🆕 휴면 상태로 간 플레이어라면 자동으로 복귀 (원래 pid 기준)
                if req_pid in room.dormant and req_pid not in room.players:
                    info = room.dormant[req_pid]
                    elapsed = int(time.time() - info.get("departed_at", time.time()))
                    restored = room.restore_from_dormant(req_pid, req_pid)
                    if restored:
                        # 복귀 서사 — 본인이 돌아온 케이스 (is_takeover=False)
                        asyncio.create_task(room.announce_return(restored, elapsed, is_takeover=False))

                if req_pid not in room.players:
                    await websocket.send_json({"type": "rejoin_failed", "reason": "플레이어 없음"})
                    continue

                # 🆕 연결-끊김 dormant 타이머가 걸려 있으면 취소
                pending = room._pending_dormant_tasks.pop(req_pid, None)
                if pending and not pending.done():
                    pending.cancel()

                # 🆕 대기실 빈방 정리 타이머도 취소 (모바일 카톡 다녀오는 케이스)
                lobby_cleanup = room._pending_lobby_cleanup
                if lobby_cleanup and not lobby_cleanup.done():
                    lobby_cleanup.cancel()
                    room._pending_lobby_cleanup = None

                player_id = req_pid
                current_room = room_id
                room.connections[player_id] = websocket
                # 방장이 공석이면 이 재접속자에게 자동 위임
                await _claim_vacant_owner(room, player_id)

                await websocket.send_json({
                    "type": "rejoin_ok",
                    "room_id": room_id,
                    "player_id": player_id,
                    "is_owner": room.owner_id == player_id,
                    "players": [p.to_dict() for p in room.players.values()],
                    "started": room.started,
                    "current_time": room.current_time,
                    "chat_log": room.chat_log[-30:],  # 대기실 채팅 최근 30개 복원
                    "narrative_log": list(room.narrative_log),
                    "turn_player_id": room.current_turn_player_id(),
                    "dormant": _dormant_summary(room),
                    "scenario": _scenario_public(room.scenario_id),
                    # 🆕 Phase 3 — 라운드 상태 (재접속 시 동기화)
                    "round_order": list(room.round_order),
                    "round_idx": room.round_idx,
                    "round_number": room.round_number,
                    "current_actor": room.current_actor(),
                    # 최근 DM 응답 복원 (narrative_log 가 더 풍부한 정보 — 하위 호환)
                    "last_dm": next(
                        (m["content"] for m in reversed(room.messages)
                         if m.get("role") == "assistant"), None),
                })
                await room.broadcast({
                    "type": "player_rejoined",
                    "player_name": room.players[player_id].name,
                }, exclude=player_id)

            elif msg == "set_portrait":
                if not current_room or current_room not in rooms or not player_id:
                    continue
                room = rooms[current_room]
                player = room.players.get(player_id)
                if not player:
                    continue
                data_url = data.get("portrait")
                # data URL 크기 체크 (1MB 제한)
                if not isinstance(data_url, str) or not data_url.startswith("data:image/"):
                    await _send_error(websocket, "잘못된 이미지 형식입니다.")
                    continue
                if len(data_url) > 1_400_000:
                    await _send_error(websocket, "이미지가 너무 큽니다 (1MB 초과).")
                    continue
                player.custom_portrait = data_url
                # DM에게 "이 플레이어가 자신의 모습을 새로 공개했다" 메모 남김 → 다음 행동 때 반영
                player.pending_notes.append(
                    f"※ {player.name}({player.race} {player.character_class})이(가) 방금 "
                    "자기 캐릭터의 모습을 직접 그려 파티에게 공개했다. "
                    "다음 서사에서 이 캐릭터의 외양/인상을 자연스럽게 한두 문장 묘사하고, "
                    "NPC나 다른 파티원의 반응을 한 마디 끼워넣어라."
                )
                await room.broadcast({
                    "type": "portrait_updated",
                    "players": [p.to_dict() for p in room.players.values()],
                })
                await save_room(room)

            elif msg == "adjust_pregame_stat":
                # 🆕 대기실 능력치 조정. 게임 시작 전 + race_mod_applied=False 상태에서만 가능.
                if not current_room or current_room not in rooms or not player_id:
                    continue
                room = rooms[current_room]
                player = room.players.get(player_id)
                if not player or room.started:
                    continue
                stat = data.get("stat")
                try:
                    delta = int(data.get("delta", 0))
                except (TypeError, ValueError):
                    continue
                if delta not in (-1, 1):
                    continue
                result = player.adjust_pregame_stat(stat, delta)
                if not result:
                    continue
                # 본인에게는 즉시 응답 (HP 같은 부수 데이터 갱신 없이 능력치만 동기화)
                # 다른 사람들에게도 알려서 대기실 카드의 ability 표시 같이 갱신.
                await room.broadcast({
                    "type": "pregame_stat_changed",
                    "player_id": player_id,
                    "stat": result["stat"],
                    "value": result["value"],
                    "total": result["total"],
                    "players": [p.to_dict() for p in room.players.values()],
                })
                await save_room(room)

            elif msg == "toggle_ready":
                # 대기실 준비 토글. 전원이 준비되면 자동 시작.
                if not current_room or current_room not in rooms or not player_id:
                    continue
                room = rooms[current_room]
                player = room.players.get(player_id)
                if not player or room.started:
                    continue

                # 🆕 준비 ON 으로 전환할 때만 능력치 총합 검증 (해제는 자유).
                # race_mod_applied 면 이미 게임 시작 흐름이 적용됐으니 검증 불필요.
                if not player.is_ready and not player.race_mod_applied:
                    total = player.ability_total()
                    if total != PREGAME_TOTAL_BUDGET:
                        await _send_error(
                            websocket,
                            f"능력치 총합 {total} — {PREGAME_TOTAL_BUDGET} 으로 분배해야 준비 가능 "
                            f"(범위 {PREGAME_STAT_MIN}~{PREGAME_STAT_MAX})."
                        )
                        continue

                player.is_ready = not player.is_ready
                await room.broadcast({
                    "type": "ready_updated",
                    "players": [p.to_dict() for p in room.players.values()],
                })
                await save_room(room)

                # 전원 준비 완료 + 시작 안 된 상태 → 자동 시작
                if room.players and all(p.is_ready for p in room.players.values()):
                    # 🆕 게임 시작 직전 — 아직 race_mod 안 받은 플레이어들 모두 처리.
                    # (apply_race_modifiers 가 자체 idempotent — 이미 적용된 사람은 None 반환)
                    race_applied_log = []
                    for p in room.players.values():
                        applied = p.apply_race_modifiers()
                        if applied:
                            race_applied_log.append((p.name, applied))
                    if race_applied_log:
                        print(f"[RACE MOD APPLIED] room={room.room_id}:")
                        for nm, ap in race_applied_log:
                            print(f"  {nm}: {ap}")
                    room.started = True
                    # 시작 중임을 브로드캐스트 (UI에 "DM 준비중" 표시 가능)
                    await room.broadcast({"type": "game_starting"})
                    try:
                        dm_intro = await room.get_dm_intro()
                    except Exception as e:
                        # 서버 콘솔에 전체 traceback 출력 (디버깅용)
                        print(f"[START FAIL] room={room.room_id} err={type(e).__name__}: {e}")
                        traceback.print_exc()
                        room.started = False
                        for p in room.players.values():
                            p.is_ready = False
                        await room.broadcast({
                            "type": "ready_updated",
                            "players": [p.to_dict() for p in room.players.values()],
                        })
                        # 타임아웃은 LLM 엔드포인트가 느린 것뿐이라, 원인을 사용자에게 분명히 알려준다.
                        # 다른 예외(네트워크/키/포맷)는 디버그용으로 타입명까지 노출.
                        if isinstance(e, LLMTimeoutError):
                            err_msg = (
                                f"DM 인트로 생성 지연 — {LLM_TIMEOUT_SEC:.0f}초 내 응답 없음. "
                                "LLM 엔드포인트가 느립니다 (무료 티어 / 콜드 스타트). "
                                "준비 완료를 다시 눌러 재시도해주세요."
                            )
                        else:
                            err_msg = f"DM 호출 실패: {type(e).__name__}: {e}"
                        await room.broadcast({
                            "type": "error",
                            "message": err_msg,
                        })
                        continue

                    # 게임 시작 시 턴은 0번부터 다시
                    room.current_turn_index = 0
                    # 서사 로그에 기록 — 신규/재입장자가 처음부터 볼 수 있게
                    room._log_narr({
                        "type": "dm",
                        "text": dm_intro,
                        "current_time": room.current_time,
                    })
                    # 🆕 Phase 3 — 게임 시작 시 첫 라운드 initiative 굴림.
                    # 이 시점엔 보통 몬스터 없음 → round_order 는 플레이어들만. 전투 발생 시 spawn 되며
                    # 그 다음 라운드부터 몬스터 포함된 순서로 재구축됨.
                    room.ensure_round_started()
                    await room.broadcast({
                        "type": "game_started",
                        "dm_text": dm_intro,
                        "players": [p.to_dict() for p in room.players.values()],
                        "current_time": room.current_time,
                        "turn_player_id": room.current_turn_player_id(),
                        "round_order": list(room.round_order),
                        "round_number": room.round_number,
                    })
                    await save_room(room)

            elif msg == "dice_roll":
                # 🔒 서버가 직접 난수를 굴린다. 클라가 보내는 result 는 완전히 무시.
                # (이전엔 클라 계산값을 범위 검증만 하고 중계 → DevTools 로 항상 20 찍기 가능했음.)
                if not current_room or current_room not in rooms or not player_id:
                    continue
                room = rooms[current_room]
                player = room.players.get(player_id)
                if not player:
                    continue
                die = str(data.get("die", "d20")).lower()
                die_map = {"d4": 4, "d6": 6, "d8": 8, "d10": 10, "d12": 12, "d20": 20, "d100": 100}
                if die not in die_map:
                    continue
                result = random.randint(1, die_map[die])
                dice_event = {
                    "type": "dice",
                    "player_id": player_id,
                    "name": player.name,
                    "emoji": player.emoji,
                    "die": die,
                    "result": result,
                    "max": die_map[die],
                }
                room._log_narr(dice_event)
                await room.broadcast({**dice_event, "type": "dice_rolled"})

            elif msg == "chat_message":
                # 대기실 채팅 (게임 중에도 허용 — 잡담용).
                # 플레이어 OR 관전자 둘 다 전송 가능. 관전자는 is_spectator 플래그.
                if not current_room or current_room not in rooms:
                    continue
                room = rooms[current_room]

                sender_name = None
                sender_emoji = None
                sender_race_emoji = None
                sender_id = None
                is_spec = False

                if player_id and player_id in room.players:
                    p = room.players[player_id]
                    sender_name = p.name
                    sender_emoji = p.emoji
                    sender_race_emoji = p.race_emoji
                    sender_id = player_id
                elif spectator_id and spectator_id in room.spectators:
                    info = room.spectators[spectator_id]
                    sender_name = info.get("name", "관전자")
                    sender_emoji = "👁"
                    sender_race_emoji = "👁"
                    sender_id = spectator_id
                    is_spec = True
                else:
                    continue  # 권한 없는 연결

                text = str(data.get("text", "")).strip()
                if not text:
                    continue
                if len(text) > CHAT_MAX_LEN:
                    text = text[:CHAT_MAX_LEN]
                entry = {
                    "player_id": sender_id,
                    "name": sender_name,
                    "emoji": sender_emoji,
                    "race_emoji": sender_race_emoji,
                    "text": text,
                    "ts": time.time(),
                    "is_spectator": is_spec,
                }
                room.chat_log.append(entry)
                if len(room.chat_log) > CHAT_LOG_CAP:
                    room.chat_log = room.chat_log[-CHAT_LOG_CAP:]
                await room.broadcast({
                    "type": "chat_broadcast",
                    "entry": entry,
                })
                await save_room(room)

            elif msg == "use_item":
                # 🆕 플레이어가 UI에서 소지품을 사용/장착.
                # data: { item_name: str, action?: 'use'|'equip', slot?: 'weapon'|'armor'|'accessory' }
                # action 미지정 시 서버가 kind 기반으로 추론:
                #   - kind=consumable → 사용 (수량 차감)
                #   - kind=equipment  → equip_required:true 회신 (클라가 confirm 띄움)
                #   - kind=quest      → 거부
                if not current_room or current_room not in rooms or not player_id:
                    continue
                room = rooms[current_room]
                player = room.players.get(player_id)
                if not player:
                    continue
                item_name = str(data.get("item_name", "")).strip()
                if not item_name:
                    continue
                action = str(data.get("action", "")).strip().lower()
                # 인벤토리에서 종류 확인
                inv_item = next((it for it in player.inventory if it.get("name") == item_name), None)
                if not inv_item:
                    await _send_error(websocket, f"'{item_name}' 을(를) 찾을 수 없습니다.")
                    continue
                kind = inv_item.get("kind", "consumable")

                # 1) 명시적 장착 요청
                if action == "equip" or (action == "" and kind == "equipment"):
                    if kind != "equipment":
                        await _send_error(websocket, f"'{item_name}' 은(는) 장비가 아닙니다.")
                        continue
                    if action == "":
                        # 자동 추론 — 클라에 confirm 요청 ("이건 장비입니다. 장착할까요?")
                        await websocket.send_json({
                            "type": "use_item_confirm",
                            "item_name": item_name,
                            "kind": "equipment",
                            "message": f"'{item_name}' 은(는) 장비입니다. 장착하시겠습니까?",
                        })
                        continue
                    slot = str(data.get("slot", "weapon")).strip().lower()
                    if slot not in ("weapon", "armor", "accessory"):
                        slot = "weapon"
                    result = player.equip_from_inventory(item_name, slot)
                    if not result:
                        await _send_error(websocket, "장착 실패.")
                        continue
                    replaced = result.get("replaced") or {}
                    player.pending_notes.append(
                        f"※ {player.name}이(가) '{item_name}'을(를) {slot} 슬롯에 장착했다."
                        + (f" 기존 '{replaced.get('name')}'은(는) 인벤토리로 회수됨." if replaced.get("name") else "")
                    )
                    await room.broadcast({
                        "type": "item_equipped",
                        "player_id": player_id,
                        "player_name": player.name,
                        "item": item_name,
                        "slot": slot,
                        "replaced": replaced.get("name"),
                        "players": [p.to_dict() for p in room.players.values()],
                    })
                    await save_room(room)
                    continue

                # 2) 퀘스트 아이템은 사용·장착 불가
                if kind == "quest":
                    await _send_error(websocket,
                        f"'{item_name}' 은(는) 퀘스트 아이템입니다. 사용/장착 불가 (DM 서사 안에서 사용됨).")
                    continue

                # 3) 소모품 사용 (기본 경로)
                result = player.use_item(item_name, 1)
                if not result:
                    await _send_error(websocket, f"'{item_name}' 을(를) 찾을 수 없습니다.")
                    continue
                player.pending_notes.append(
                    f"※ {player.name}이(가) 방금 소지품 '{result['name']}'을(를) 사용했다. "
                    f"남은 수량 {result['remaining']}. "
                    "효과를 자연스럽게 서사에 반영하고, 필요 시 HP/MP/상태 태그로 결과 표기."
                )
                await room.broadcast({
                    "type": "item_used",
                    "player_id": player_id,
                    "player_name": player.name,
                    "item": result["name"],
                    "remaining": result["remaining"],
                    "players": [p.to_dict() for p in room.players.values()],
                })
                await save_room(room)

            elif msg == "pass_turn":
                # 🆕 본인이 자기 턴을 그냥 넘김. LLM 호출 없음, 다음 사람에게 차례.
                # 방장 전용 skip_turn 과 달리 **자기 자신만** 넘길 수 있다 (인질극 방지).
                if not current_room or current_room not in rooms or not player_id:
                    continue
                room = rooms[current_room]
                if not room.started:
                    await _send_error(websocket, "게임이 아직 시작되지 않았습니다.")
                    continue
                cur = room.current_turn_player_id()
                if cur != player_id:
                    await _send_error(websocket, "본인 차례가 아닙니다.")
                    continue
                me = room.players.get(player_id)
                room.advance_turn()
                await room.broadcast({
                    "type": "turn_auto_skipped",
                    "skipped_player_name": me.name if me else "?",
                    "reason": "본인 패스",
                    "turn_player_id": room.current_turn_player_id(),
                })

            elif msg == "linger_action":
                # 🆕 "관망/계속 진행" — 행동 없이 DM 이 장면을 한 단계 진척.
                # 본인 차례에서만 가능. 액션 텍스트는 서버가 자동 생성 → 일반 player_action 경로로.
                if not current_room or current_room not in rooms or not player_id:
                    continue
                room = rooms[current_room]
                player = room.players.get(player_id)
                if not player or not room.started:
                    continue
                cur = room.current_turn_player_id()
                if cur != player_id:
                    await _send_error(websocket, "본인 차례에만 관망할 수 있습니다.")
                    continue
                # 쿨다운 체크
                remaining = room.cooldown_remaining(player_id)
                if remaining > 0:
                    await _send_error(websocket, f"너무 빠릅니다. {remaining:.1f}초 뒤에 다시 시도하세요.")
                    continue
                # 자동 액션 텍스트 — DM 이 장면을 한 단계 진척시키도록 유도
                action_text = "(잠시 행동을 멈추고 주변 상황을 지켜본다 — 장면이 자연스럽게 다음 단계로 흐르길 기다린다)"
                room._log_narr({
                    "type": "action",
                    "player_id": player_id,
                    "player_name": player.name,
                    "player_emoji": player.emoji,
                    "portrait_url": player.effective_portrait(),
                    "action": action_text,
                    "linger": True,
                })
                await room.broadcast({
                    "type": "action_taken",
                    "player_name": player.name,
                    "action": "🌫 관망 — DM 의 진행을 기다림",
                    "player_emoji": player.emoji,
                    "portrait_url": player.effective_portrait(),
                    "player_id": player_id,
                })
                try:
                    dm_text, events = await room.process_action(player_id, action_text)
                except LLMTimeoutError as e:
                    print(f"[LINGER TIMEOUT] room={room.room_id}: {e}")
                    await room.broadcast({
                        "type": "error",
                        "message": f"DM 응답 지연 — {LLM_TIMEOUT_SEC:.0f}초 내 응답 없음.",
                    })
                    continue
                except Exception as e:
                    print(f"[LINGER FAIL] room={room.room_id} err={type(e).__name__}: {e}")
                    traceback.print_exc()
                    await room.broadcast({
                        "type": "error",
                        "message": f"DM 호출 실패: {type(e).__name__}: {e}",
                    })
                    continue
                round_complete = room.advance_turn()
                room._log_narr({
                    "type": "dm",
                    "text": dm_text,
                    "current_time": room.current_time,
                    "acting_player_id": player_id,
                    "round_complete": round_complete,
                })
                await room.broadcast({
                    "type": "dm_response",
                    "text": dm_text,
                    "players": [p.to_dict() for p in room.players.values()],
                    "current_time": room.current_time,
                    "events": events,
                    "turn_player_id": room.current_turn_player_id(),
                    "round_complete": round_complete,
                    "acting_player_id": player_id,
                })
                await save_room(room)

            elif msg == "spend_stat_point":
                # 🆕 플레이어가 레벨업 보상 포인트를 원하는 스탯에 투자.
                if not current_room or current_room not in rooms or not player_id:
                    continue
                room = rooms[current_room]
                player = room.players.get(player_id)
                if not player:
                    continue
                stat = str(data.get("stat", "")).strip()
                result = player.spend_stat_point(stat)
                if not result:
                    await _send_error(websocket,
                        "포인트가 없거나 잘못된 스탯입니다." if player.stat_points == 0
                        else f"'{stat}' 은(는) 유효한 스탯이 아닙니다 (max_hp/max_mp/attack/defense).")
                    continue
                await room.broadcast({
                    "type": "stat_point_spent",
                    "player_id": player_id,
                    "player_name": player.name,
                    "stat": result["stat"],
                    "delta": result["delta"],
                    "remaining_points": result["remaining_points"],
                    "players": [p.to_dict() for p in room.players.values()],
                })
                await save_room(room)

            elif msg == "clear_portrait":
                # 커스텀 초상화 제거 → AI 초상화로 복원
                if not current_room or current_room not in rooms or not player_id:
                    continue
                room = rooms[current_room]
                player = room.players.get(player_id)
                if not player:
                    continue
                player.custom_portrait = None
                await room.broadcast({
                    "type": "portrait_updated",
                    "players": [p.to_dict() for p in room.players.values()],
                })
                await save_room(room)

            elif msg == "leave_room":
                # 🔄 자발적 퇴장. 이전에는 플레이어 완전 삭제였으나, 이제는 **휴면(dormant)** 으로 이동.
                #   - 2분 안에 재접속하면 그대로 이어서 플레이
                #   - 2분 경과 후 다른 사람이 이 방 코드로 입장하면 이 캐릭터 takeover 선택 가능
                if not current_room or current_room not in rooms or not player_id:
                    continue
                room = rooms[current_room]
                # 현재 턴이었는지 미리 판별
                was_current_turn = (room.current_turn_player_id() == player_id)
                owner_was_me = (room.owner_id == player_id)

                if room.started:
                    # 게임 중이면 dormant 로 이동
                    player = room._move_to_dormant(player_id)
                    if player:
                        # 방장 승계 — 연결된 후보 없으면 owner_vacant 로 표식만 남김
                        if owner_was_me and room.players:
                            await _transfer_owner_or_vacate(room, player_id)
                        # 턴 자동 스킵 (현재 턴이었을 때만)
                        if was_current_turn:
                            await room.broadcast({
                                "type": "turn_auto_skipped",
                                "skipped_player_name": player.name,
                                "reason": "파티를 떠남",
                                "turn_player_id": room.current_turn_player_id(),
                            })
                        # 파티 리스트 업데이트 브로드캐스트
                        await room.broadcast({
                            "type": "player_left",
                            "player_name": player.name,
                            "players": [p.to_dict() for p in room.players.values()],
                            "turn_player_id": room.current_turn_player_id(),
                            "went_dormant": True,
                            "dormant": _dormant_summary(room),
                        })
                        # DM 내러티브 비동기로 생성·방송
                        asyncio.create_task(room.announce_departure(player))
                else:
                    # 대기실에서 나간 거면 그냥 삭제 (게임 시작 전엔 dormant 의미 없음)
                    player = room.players.pop(player_id, None)
                    room.connections.pop(player_id, None)
                    room.remove_from_turn_order(player_id)
                    if player:
                        if owner_was_me and room.players:
                            await _transfer_owner_or_vacate(room, player_id)
                        await room.broadcast({
                            "type": "player_left",
                            "player_name": player.name,
                            "players": [p.to_dict() for p in room.players.values()],
                            "turn_player_id": room.current_turn_player_id(),
                        })

                # 클라이언트에게 세션 지우라고 알림
                try:
                    await websocket.send_json({"type": "left_room"})
                except Exception:
                    pass
                # 방이 완전히 비면 정리 (플레이어도 없고 dormant 도 없고 관전자도 없을 때)
                if not room.players and not room.dormant and not room.spectators:
                    rooms.pop(current_room, None)
                    delete_save(current_room)
                else:
                    await save_room(room)
                current_room = None
                player_id = None

            elif msg == "takeover_character":
                # 🆕 2분 경과한 휴면 캐릭터를 이어받아 플레이.
                # 기대 페이로드: {room_id, dormant_player_id}
                room_id = str(data.get("room_id", "")).upper().strip()
                dormant_pid = str(data.get("dormant_player_id", "")).strip()
                if not room_id or room_id not in rooms:
                    await _send_error(websocket, "방을 찾을 수 없습니다.")
                    continue
                room = rooms[room_id]
                if dormant_pid not in room.dormant:
                    await _send_error(websocket, "이어받을 캐릭터를 찾을 수 없습니다.")
                    continue
                info = room.dormant[dormant_pid]
                elapsed = time.time() - info.get("departed_at", time.time())
                if elapsed < DORMANT_TAKEOVER_DELAY_SEC:
                    remain = DORMANT_TAKEOVER_DELAY_SEC - elapsed
                    await _send_error(
                        websocket,
                        f"이 캐릭터는 {int(remain)}초 후에 이어받을 수 있습니다."
                    )
                    continue

                player_id = player_id or str(uuid.uuid4())[:8]
                current_room = room_id
                player = room.restore_from_dormant(dormant_pid, player_id)
                if not player:
                    await _send_error(websocket, "이어받기 실패.")
                    continue
                room.connections[player_id] = websocket
                await _claim_vacant_owner(room, player_id)

                await websocket.send_json({
                    "type": "joined_room",
                    "room_id": room_id,
                    "player_id": player_id,
                    "is_owner": room.owner_id == player_id,
                    "players": [p.to_dict() for p in room.players.values()],
                    "started": room.started,
                    "turn_player_id": room.current_turn_player_id(),
                    "took_over": True,
                    "taken_over_name": player.name,
                })
                await room.broadcast({
                    "type": "player_joined",
                    "player": player.to_dict(),
                    "players": [p.to_dict() for p in room.players.values()],
                    "turn_player_id": room.current_turn_player_id(),
                    "took_over": True,
                }, exclude=player_id)
                # DM 복귀 서사
                asyncio.create_task(room.announce_return(player, int(elapsed), is_takeover=True))

            elif msg == "kick_player":
                # 방장 전용 — 다른 플레이어 강퇴. 게임 중이면 턴도 자동 스킵.
                if not current_room or current_room not in rooms or not player_id:
                    continue
                room = rooms[current_room]
                if room.owner_id != player_id:
                    await _send_error(websocket, "방장만 강퇴할 수 있습니다.")
                    continue
                target_id = str(data.get("target_id", "")).strip()
                if not target_id or target_id == player_id:
                    continue

                # 🆕 강퇴 대상이 현재 턴이었는지 미리 판별
                was_current_turn = (room.current_turn_player_id() == target_id)

                target = room.players.pop(target_id, None)
                target_ws = room.connections.pop(target_id, None)
                room.remove_from_turn_order(target_id)
                if not target:
                    continue
                owner_name = room.players[player_id].name if player_id in room.players else "방장"
                # 강퇴당한 대상에게 알림
                if target_ws:
                    try:
                        await target_ws.send_json({
                            "type": "kicked",
                            "by": owner_name,
                        })
                        await target_ws.close()
                    except Exception:
                        pass
                # 🆕 게임 중 강퇴: 턴 자동 스킵 이벤트 발송 (현재 턴이었을 때만)
                if room.started and was_current_turn:
                    await room.broadcast({
                        "type": "turn_auto_skipped",
                        "skipped_player_name": target.name,
                        "reason": f"{owner_name}에 의해 강퇴됨",
                        "turn_player_id": room.current_turn_player_id(),
                    })
                await room.broadcast({
                    "type": "player_left",
                    "player_name": target.name + " (강퇴됨)",
                    "players": [p.to_dict() for p in room.players.values()],
                    "turn_player_id": room.current_turn_player_id(),
                })
                if not room.players:
                    rooms.pop(current_room, None)
                    delete_save(current_room)
                else:
                    await save_room(room)

            elif msg == "force_unlock_dormant":
                # 🆕 2단계 확인. 방장이 잠깐 끊긴 플레이어 캐릭터를 마음대로 넘기는 걸 방지.
                #   1차 요청 (confirm=False) → 서버는 `dormant_unlock_pending` 이벤트로 대상 정보 + 남은 시간 알려주고 대기.
                #   2차 요청 (confirm=True, 30초 내) → 실제 해제.
                if not current_room or current_room not in rooms or not player_id:
                    continue
                room = rooms[current_room]
                if room.owner_id != player_id:
                    await _send_error(websocket, "방장만 휴면 잠금을 해제할 수 있습니다.")
                    continue
                target_id = str(data.get("target_id", "")).strip()
                info = room.dormant.get(target_id)
                if not info:
                    await _send_error(websocket, "해당 휴면 캐릭터가 없습니다.")
                    continue
                confirm = bool(data.get("confirm", False))
                name = info["player"].name if isinstance(info.get("player"), Player) else target_id
                elapsed = int(time.time() - info.get("departed_at", time.time()))
                unlock_in = max(0, DORMANT_TAKEOVER_DELAY_SEC - elapsed)

                if not confirm:
                    # 1차 — 확인 요청
                    room._pending_force_unlocks[target_id] = time.time()
                    await websocket.send_json({
                        "type": "dormant_unlock_pending",
                        "target_id": target_id,
                        "target_name": name,
                        "elapsed_sec": elapsed,
                        "unlock_in_sec": unlock_in,
                        "needs_confirm": True,
                        "message": (
                            f"{name} 이(가) 파티를 떠난 지 {elapsed}초. 타이머 해제를 확정하려면 "
                            "30초 안에 다시 요청하세요 (confirm=true)."
                        ),
                    })
                    continue

                # 2차 — 30초 내 유효
                pend_ts = room._pending_force_unlocks.pop(target_id, None)
                if pend_ts is None or (time.time() - pend_ts) > 30:
                    await _send_error(websocket,
                        "확인 요청이 만료되었습니다. 해제를 원하면 다시 처음부터 시도하세요.")
                    continue
                info["departed_at"] = time.time() - DORMANT_TAKEOVER_DELAY_SEC - 5
                await room.broadcast({
                    "type": "dormant_unlocked",
                    "target_id": target_id,
                    "target_name": name,
                    "by": room.players[player_id].name if player_id in room.players else "방장",
                    "dormant": _dormant_summary(room),
                })
                await save_room(room)

            elif msg == "skip_turn":
                # 🆕 방장이 수동으로 현재 턴을 스킵 (AFK 플레이어 대응). 턴만 넘기고 DM 호출 없음.
                if not current_room or current_room not in rooms or not player_id:
                    continue
                room = rooms[current_room]
                if room.owner_id != player_id:
                    await _send_error(websocket, "방장만 턴을 스킵할 수 있습니다.")
                    continue
                if not room.started:
                    continue
                skipped_id = room.current_turn_player_id()
                if not skipped_id:
                    continue
                skipped = room.players.get(skipped_id)
                room.advance_turn()
                await room.broadcast({
                    "type": "turn_auto_skipped",
                    "skipped_player_name": skipped.name if skipped else "알 수 없음",
                    "reason": "방장이 턴을 스킵함",
                    "turn_player_id": room.current_turn_player_id(),
                })

            elif msg == "clear_monsters":
                # 🆕 방장 안전망 — DM 이 [적 퇴장] 을 빠뜨려서 카드가 잔존할 때 강제 정리.
                # 모든 monsters 를 한꺼번에 비우고, 다음 응답에서 broadcast 가 빈 배열을 동봉해 UI 에서 사라짐.
                if not current_room or current_room not in rooms or not player_id:
                    continue
                room = rooms[current_room]
                if room.owner_id != player_id:
                    await _send_error(websocket, "방장만 사용할 수 있습니다.")
                    continue
                if not room.monsters:
                    continue
                names = list(room.monsters.keys())
                room.monsters.clear()
                print(f"[CLEAR MONSTERS] room={room.room_id} owner={player_id} cleared={names}")
                await room.broadcast({
                    "type": "monsters_cleared",
                    "cleared": names,
                    "players": [p.to_dict() for p in room.players.values()],
                })
                await save_room(room)

            elif msg == "player_action":
                if not current_room or current_room not in rooms or not player_id:
                    continue
                room = rooms[current_room]
                player = room.players.get(player_id)
                if not player:
                    continue
                if not room.started:
                    await _send_error(websocket, "게임이 아직 시작되지 않았습니다.")
                    continue

                # 🆕 사망자 행동 차단 — HP 0 인 플레이어는 행동 불가. 채팅(chat_message)은 별개로 허용됨.
                if not player.is_alive():
                    await _send_error(
                        websocket,
                        "사망 상태입니다. 동료가 부활시켜주거나 구원의 빛이 임해야 행동 가능."
                    )
                    continue

                # 턴 체크 — 현재 차례인 플레이어만 행동 가능
                cur_turn = room.current_turn_player_id()
                if cur_turn and cur_turn != player_id:
                    cur_player = room.players.get(cur_turn)
                    turn_name = cur_player.name if cur_player else "다음 차례"
                    await _send_error(
                        websocket,
                        f"당신 차례가 아닙니다. 지금은 {turn_name}의 차례."
                    )
                    continue

                # 레이트리밋: 너무 빠른 연속 행동 차단
                remaining = room.cooldown_remaining(player_id)
                if remaining > 0:
                    await _send_error(
                        websocket,
                        f"너무 빠릅니다. {remaining:.1f}초 뒤에 다시 시도하세요."
                    )
                    continue

                action_text = str(data.get("action", "")).strip()
                if not action_text:
                    continue
                if len(action_text) > ACTION_MAX_LEN:
                    action_text = action_text[:ACTION_MAX_LEN]
                # 🔒 프롬프트 주입 완화 — 플레이어가 `[...]` 로 태그 문법을 흉내내는 걸 방지.
                # 파서는 ASCII `[]` 만 인식하므로 전각 치환해도 DM 이 찍는 실제 태그와 충돌 없음.
                action_text = sanitize_player_action(action_text)

                room._log_narr({
                    "type": "action",
                    "player_id": player_id,
                    "player_name": player.name,
                    "player_emoji": player.emoji,
                    "portrait_url": player.effective_portrait(),
                    "action": action_text,
                })
                await room.broadcast({
                    "type": "action_taken",
                    "player_name": player.name,
                    "action": action_text,
                    "player_emoji": player.emoji,
                    "portrait_url": player.effective_portrait(),
                    "player_id": player_id,
                })

                try:
                    dm_text, events = await room.process_action(player_id, action_text)
                except LLMTimeoutError as e:
                    # 타임아웃 전용 처리 — 턴은 넘기지 않고 에러만 알림.
                    # 쿨다운은 이미 기록됐으니 3초 뒤 재시도 가능.
                    print(f"[ACTION TIMEOUT] room={room.room_id} player={player_id}: {e}")
                    await room.broadcast({
                        "type": "error",
                        "message": f"DM 응답 지연 — {LLM_TIMEOUT_SEC:.0f}초 내 응답 없음. 잠시 후 다시 시도해주세요.",
                    })
                    continue
                except Exception as e:
                    print(f"[ACTION FAIL] room={room.room_id} err={type(e).__name__}: {e}")
                    traceback.print_exc()
                    await room.broadcast({
                        "type": "error",
                        "message": f"DM 호출 실패: {type(e).__name__}: {e}",
                    })
                    continue

                # 턴 넘기기 (라운드 완료 여부도 추적). 🆕 advance_turn 이 사망자 자동 스킵.
                # Phase 3: round_order 활성 시 advance_turn 이 advance_actor 위임 → 몬스터 턴 포함된 다음 actor 로.
                round_complete = room.advance_turn()

                # 🆕 라운드 종료 시 모든 몬스터의 status_effects 를 한 번 tick.
                # DOT(독·화상 등) 가 여기서 적용되고, 죽으면 처치자에게 XP 자동 분배.
                if round_complete:
                    round_tick_events = room.tick_monsters_round()
                    if round_tick_events:
                        events.setdefault("monster_events", []).extend(
                            e for e in round_tick_events if e.get("kind") in ("tick", "status_expired", "defeated")
                        )
                        xp_extra = [e for e in round_tick_events if e.get("kind") in ("kill", "assist")]
                        if xp_extra:
                            events.setdefault("xp_events", []).extend(xp_extra)
                # 몬스터 체인은 dm_response 브로드캐스트 *후* 실행됨 (아래 코드 블록 참조) —
                # 이전엔 chain 안에서 monster_turn 이 먼저 broadcast 돼 narrative log 의 순서가 어긋났음.

                # 🆕 TPK 처리 — 파티 전멸 시 DM 에게 한 번 더 호출해서 구원 OR 비극 종결.
                if room.is_tpk():
                    rescue_items = room.find_rescue_items()
                    if rescue_items:
                        rescue_lines = "\n".join(
                            f"  - {nm}: {it} ({eff or '효과 미공개 — 신비로운 힘'})"
                            for nm, it, eff in rescue_items[:6]
                        )
                        tpk_prompt = (
                            "[시스템: 파티 전원이 쓰러졌다 (HP 0). 그러나 인벤토리에 구원의 가능성이 있는 "
                            "아이템이 있다. 그 중 하나가 발동하는 극적인 장면을 묘사해라. "
                            "발동된 아이템은 `[이름 사용: 아이템명]` 으로 소비, 살아난 파티원의 HP 를 "
                            "`[이름 HP: 0 → N]` 으로 회복시켜라 (살아난 사람당 max_hp 의 30% 이상). "
                            f"구원 후보:\n{rescue_lines}\n"
                            "여러 명을 동시에 구할 필요는 없음 — 한 명이라도 일어서면 이야기는 이어진다.]"
                        )
                    else:
                        tpk_prompt = (
                            "[시스템: 파티 전원이 쓰러졌다 (HP 0). 인벤토리에도 구원할 수단이 없다. "
                            "비극적이지만 품격 있는 종결 장면을 그려라. 마지막에 "
                            "`[캠페인 종료: tpk]` 태그를 반드시 찍을 것. 5문장 이내.]"
                        )
                    try:
                        async with room.lock:
                            room.messages.append({"role": "user", "content": tpk_prompt})
                            tpk_text = await llm_complete(
                                build_system_prompt(room.scenario_id),
                                room._llm_slice(),
                                max_tokens=500
                            )
                            tpk_text = _strip_numeric_stat_mentions(tpk_text)  # 🆕 사후 수치 필터
                            room.messages.append({"role": "assistant", "content": tpk_text})
                            tpk_events = room._parse_all_tags(tpk_text, tick_statuses=False)
                            room._trim_messages()
                        # DM 추가 응답을 본 응답에 이어붙여서 한 메시지로 전달
                        dm_text = dm_text + "\n\n" + tpk_text
                        # 이벤트 머지 — TPK 후속 호출이 만든 새 이벤트도 토스트·UI 갱신에 반영
                        for k in ("xp_events", "items", "item_uses", "hp_affected",
                                  "mp_affected", "monster_events", "statuses_applied",
                                  "statuses_expired", "newly_dead"):
                            if tpk_events.get(k):
                                events.setdefault(k, []).extend(tpk_events[k])
                        if tpk_events.get("campaign_ending") and not events.get("campaign_ending"):
                            events["campaign_ending"] = tpk_events["campaign_ending"]
                        events["tpk_handled"] = True
                        events["tpk_had_rescue"] = bool(rescue_items)
                    except Exception as e:
                        print(f"[TPK FAIL] room={room.room_id} err={type(e).__name__}: {e}")
                        # TPK 실패해도 본 응답은 그대로 진행

                room._log_narr({
                    "type": "dm",
                    "text": dm_text,
                    "current_time": room.current_time,
                    "acting_player_id": player_id,
                    "round_complete": round_complete,
                })
                # 🆕 dm_response 를 monster chain 보다 *먼저* 브로드캐스트.
                # 이전: chain 안에서 monster_turn 이 먼저 broadcast 돼 narrative log 가 어긋났음
                # (플레이어 액션 결과 묘사 → 검은 사제 등장 → 검은 사제 행동 순으로 떠야 정상,
                #  이전엔 검은 사제 행동이 플레이어 액션 결과보다 먼저 표시됨).
                await room.broadcast({
                    "type": "dm_response",
                    "text": dm_text,
                    "players": [p.to_dict() for p in room.players.values()],
                    "current_time": room.current_time,
                    "events": events,
                    "turn_player_id": room.current_turn_player_id(),
                    "round_complete": round_complete,
                    "acting_player_id": player_id,
                    # 🆕 Phase 3 — 라운드 상태 (UI 가 다음 차례 표시 등에 활용)
                    "round_order": list(room.round_order),
                    "round_idx": room.round_idx,
                    "round_number": room.round_number,
                    "current_actor": room.current_actor(),
                })

                # 🆕 Phase 3 — dm_response 후 몬스터 체인 (이제 시간 순서대로 narrative log 에 쌓임).
                # TPK 면 chain 안 돌림 (위 TPK 처리에서 이미 dm_text 에 결말 포함됨).
                MONSTER_CHAIN_MAX = 6
                if not events.get("tpk_handled"):
                    for _ in range(MONSTER_CHAIN_MAX):
                        if room.is_tpk():
                            break
                        next_actor = room.current_actor()
                        if not next_actor or next_actor.get("kind") != "monster":
                            break  # 플레이어 차례면 멈춤 (입력 대기)
                        monster_id = next_actor.get("id")
                        try:
                            m_text, m_events = await room.process_monster_turn(monster_id)
                        except LLMTimeoutError as e:
                            print(f"[MONSTER TURN TIMEOUT] {monster_id}: {e} — 스킵하고 진행")
                            m_text, m_events = None, {}
                        except Exception as e:
                            print(f"[MONSTER TURN FAIL] {monster_id}: {type(e).__name__}: {e}")
                            m_text, m_events = None, {}
                        if m_text:
                            room._log_narr({
                                "type": "monster_turn",
                                "monster_name": monster_id,
                                "text": m_text,
                                "current_time": room.current_time,
                            })
                            # 다음 actor / 라운드 정보도 동봉 — 클라가 라운드 트래커 갱신
                            chain_round_complete = room.advance_turn()
                            chain_tick_events = []
                            if chain_round_complete:
                                chain_tick_events = room.tick_monsters_round()
                            await room.broadcast({
                                "type": "monster_turn",
                                "monster_name": monster_id,
                                "text": m_text,
                                "events": m_events or {},
                                "round_tick_events": chain_tick_events,
                                "players": [p.to_dict() for p in room.players.values()],
                                "round_order": list(room.round_order),
                                "round_idx": room.round_idx,
                                "round_number": room.round_number,
                                "current_actor": room.current_actor(),
                                "turn_player_id": room.current_turn_player_id(),
                            })
                        else:
                            # text 못 받았으면 advance 만 하고 계속
                            room.advance_turn()
                await save_room(room)  # 💾 핵심 — DM 응답 + 몬스터 체인 후 전체 스냅샷

    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[WS] unexpected error: {e}")
    finally:
        # 관전자가 나간 경우 — 플레이어 처리와 별개
        if current_room and current_room in rooms and spectator_id:
            room = rooms[current_room]
            if spectator_id in room.spectators:
                info = room.spectators.pop(spectator_id, None)
                if info:
                    try:
                        await room.broadcast({
                            "type": "spectator_left",
                            "spectator_name": info.get("name", "관전자"),
                            "spectator_count": len(room.spectators),
                        })
                    except Exception:
                        pass

        # 재연결 여지를 주기 위해 connection만 제거. 플레이어는 방에 남김.
        if current_room and current_room in rooms and player_id:
            room = rooms[current_room]
            room.connections.pop(player_id, None)
            # 🔄 즉시 advance_turn + 스킵 공지 **제거**.
            # 이전: 연결 끊기는 즉시 "턴 스킵" → 90초 후 "파티 이탈" 의 두 이벤트로 갈라져 혼란.
            # 지금: grace 기간 동안 해당 플레이어 차례면 다른 사람들은 그냥 기다리고 (또는 방장이 수동 스킵 가능),
            #      grace 만료 시 dormant 처리가 턴 스킵 + 이탈 + 내러티브를 한 번에 묶어서 처리.

            # 🆕 게임 중 연결 끊김 → grace 시간 후 dormant 처리.
            # 그 사이에 같은 player_id 로 rejoin 하면 타이머 취소됨.
            if room.started and player_id in room.players:
                async def _grace_then_dormant(pid: str, rid: str):
                    try:
                        await asyncio.sleep(DISCONNECT_DORMANT_GRACE_SEC)
                        if rid not in rooms:
                            return
                        r = rooms[rid]
                        # 그 사이 재접속했는지 확인 — 재접속했다면 connections 에 다시 생김
                        if pid in r.connections:
                            return
                        # 아직 플레이어 목록에 있고 연결 없음 → 휴면으로 이동
                        if pid in r.players:
                            was_current_turn = (r.current_turn_player_id() == pid)
                            owner_was = (r.owner_id == pid)
                            p = r._move_to_dormant(pid)
                            if p:
                                if owner_was and r.players:
                                    await _transfer_owner_or_vacate(r, pid)
                                if was_current_turn:
                                    await r.broadcast({
                                        "type": "turn_auto_skipped",
                                        "skipped_player_name": p.name,
                                        "reason": "연결 끊김으로 파티 이탈",
                                        "turn_player_id": r.current_turn_player_id(),
                                    })
                                await r.broadcast({
                                    "type": "player_left",
                                    "player_name": p.name,
                                    "players": [pp.to_dict() for pp in r.players.values()],
                                    "turn_player_id": r.current_turn_player_id(),
                                    "went_dormant": True,
                                    "dormant": _dormant_summary(r),
                                })
                                asyncio.create_task(r.announce_departure(p))
                    except asyncio.CancelledError:
                        pass
                    finally:
                        r = rooms.get(rid)
                        if r:
                            r._pending_dormant_tasks.pop(pid, None)

                # 기존 타이머 있으면 덮어쓰기
                old = room._pending_dormant_tasks.pop(player_id, None)
                if old and not old.done():
                    old.cancel()
                task = asyncio.create_task(_grace_then_dormant(player_id, current_room))
                room._pending_dormant_tasks[player_id] = task

            # 방이 비었고(아무도 접속 중 아님) 시작 안 된 상태 — 이전: 즉시 방 삭제 (모바일 친구가
            # 방 만들자마자 카톡으로 전환 → WS 죽음 → 돌아오면 방 없음 에러로 튕김).
            # 지금: LOBBY_EMPTY_GRACE_SEC 후에도 여전히 비어있으면 그때 정리. 그 사이 재접속하면
            # rejoin_room 핸들러가 이 타이머를 취소.
            if not room.connections and not room.started:
                rid = current_room
                old_task = room._pending_lobby_cleanup
                if old_task and not old_task.done():
                    old_task.cancel()

                async def _cleanup_empty_lobby(rid_: str):
                    try:
                        await asyncio.sleep(LOBBY_EMPTY_GRACE_SEC)
                        r = rooms.get(rid_)
                        if not r:
                            return
                        # 여전히 비어있고 시작 안 된 상태일 때만 정리
                        if r.connections or r.started:
                            return
                        # 모든 플레이어 제거 + 방 삭제
                        r.players.clear()
                        if not r.dormant:
                            rooms.pop(rid_, None)
                            delete_save(rid_)
                            print(f"[LOBBY CLEANUP] room={rid_} — {LOBBY_EMPTY_GRACE_SEC}초 동안 아무도 재접속 안함, 방 삭제")
                    except asyncio.CancelledError:
                        pass
                    finally:
                        r = rooms.get(rid_)
                        if r:
                            r._pending_lobby_cleanup = None

                room._pending_lobby_cleanup = asyncio.create_task(_cleanup_empty_lobby(rid))


app.mount("/static", StaticFiles(directory="static"), name="static")

if __name__ == "__main__":
    import uvicorn
    game_port = int(os.getenv("GAME_PORT", "8080"))
    uvicorn.run(app, host="0.0.0.0", port=game_port)
