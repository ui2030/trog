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
LLM_TIMEOUT_SEC = float(os.getenv("LLM_TIMEOUT_SEC", "30"))


class LLMTimeoutError(Exception):
    """LLM 호출이 LLM_TIMEOUT_SEC 내에 응답을 못 준 경우."""


async def llm_complete(system: str, messages: List[dict], max_tokens: int = 600) -> str:
    """두 백엔드 모두 같은 인터페이스로 호출 (비동기). 타임아웃 내 응답 없으면 예외."""
    async def _call():
        if LLM_MODE == "wrapper":
            resp = await llm_client.chat.completions.create(
                model=LLM_MODEL,
                max_tokens=max_tokens,
                messages=[{"role": "system", "content": system}] + messages,
            )
            return resp.choices[0].message.content
        else:
            resp = await llm_client.messages.create(
                model=LLM_MODEL,
                max_tokens=max_tokens,
                system=system,
                messages=messages,
            )
            return resp.content[0].text
    try:
        return await asyncio.wait_for(_call(), timeout=LLM_TIMEOUT_SEC)
    except asyncio.TimeoutError as e:
        raise LLMTimeoutError(f"LLM 응답 {LLM_TIMEOUT_SEC:.0f}s 초과") from e

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
        "hp": 120, "mp": 30, "attack": 15, "defense": 10, "emoji": "⚔️",
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
        "hp": 70, "mp": 150, "attack": 22, "defense": 5, "emoji": "🔮",
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
        "hp": 90, "mp": 60, "attack": 18, "defense": 7, "emoji": "🗡️",
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
        "hp": 100, "mp": 120, "attack": 10, "defense": 12, "emoji": "✨",
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


def pick_random_race() -> str:
    # 🆕 수인은 추가 설정(동물/비율) 필요하므로 '랜덤 배정' 대상에서 제외.
    pool = [r for r in RACES.keys() if r != "수인"]
    return random.choice(pool)


def _beastfolk_portrait(animal: str, ratio: int) -> str:
    """수인 초상화 프롬프트 — 5단 버킷으로 슬라이더 변화를 반영.
    ratio 는 호출 전에 validate_race_params 에서 [10, 90] 로 보장됨."""
    a = BEASTFOLK_ANIMALS[animal]
    r = int(ratio)
    if r <= 25:
        trait = a["trait_low"]
        weight = "predominantly human face and body with beastfolk hints"
    elif r <= 45:
        trait = a["trait_mid1"]
        weight = "mostly human with visible beastfolk features"
    elif r <= 55:
        trait = a["trait_mid"]
        weight = f"balanced half-human half-{a['name_en']} hybrid"
    elif r <= 70:
        trait = a["trait_mid2"]
        weight = f"more {a['name_en']} than human, still clearly humanoid"
    else:
        trait = a["trait_high"]
        weight = f"strongly {a['name_en']}-featured beastfolk, still a humanoid hero (not a furry animal character)"
    # "dark fantasy CRPG hero" 토큰을 명시해 퍼리 아트 방향으로 치우치는 걸 방지.
    return f"a dark fantasy CRPG hero, beastfolk ancestry — {weight}; features: {trait}"


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
    """Pollinations.ai 이미지 URL — 종족+직업 조합 기반. 수인은 동물/비율 까지 반영."""
    cls_info = CLASS_STATS.get(character_class, CLASS_STATS["전사"])
    if race == "수인":
        race_portrait = _beastfolk_portrait(race_animal or "늑대", race_ratio if race_ratio is not None else 50)
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


DM_SYSTEM_PROMPT = """당신은 어두운 판타지 RPG의 던전 마스터입니다. 발더스 게이트 스타일의 세계를 배경으로 합니다.

## 톤 & 스타일
- 반드시 한국어로 응답하세요
- **플레이어 이름의 뉘앙스를 반드시 서사에 녹여라**. 예시:
  · "허접" "찐따" 같은 자조적/웃긴 이름 → 위트와 자조적 농담 섞기. NPC들이 이름 듣고 피식하거나 비꼬는 반응.
  · "강철왕" "드래곤슬레이어" 같은 거창한 이름 → 서사시 톤. 이름에 걸맞은 칭송이나 위압감.
  · 평범한 이름 → 표준 판타지 톤.
- 종족 특성도 적극 활용 (엘프의 예민한 감각, 오크의 야성, 티플링의 악마적 시선 등)
- **수인은 파티 요약에 `수인(동물·구간·%)` 형식으로 주어짐**. 반드시 반영:
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
- **DM 주사위 굴림은 반드시 이 포맷**: `[🎲DM d20: X]` 또는 `[🎲DM d6: X]` 등.
  (DM이 굴리는 어떤 주사위든 반드시 `🎲DM` 접두사 사용. 플레이어가 굴린 주사위는 클라이언트가 자동 중계함.)
  예: `적의 반격 명중 판정 [🎲DM d20: 14]`
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
- **상태 메모**: `[적 상태: 고블린 A | 넘어짐 — 다음 공격 +4 유리]` — 디버프/상태효과 텍스트. 빈 값이면 해제
- **퇴장**: `[적 퇴장: 고블린 A]` — 도망·합류·합체 등 HP 0 아닌 소멸
- 등장 때 정한 **풀네임을 이후 태그에서 그대로 재사용**. ("고블린 A" 로 등장시켰으면 계속 "고블린 A" — 약칭 "A" 로 쓰지 말 것)
- ❌ **금지**: "⚔ 전투 중 — A/B/C(HP 12)" 같은 텍스트 상태요약. 태그만 써도 UI 가 자동 표시함

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

## 창의력 장려
- 플레이어가 특이하거나 엉뚱한 시도를 하면 **단순히 실패로 치지 말고** 흥미로운 결과를 만들어라.
  판정이 실패해도 이야기가 전진하게 하라 ("Yes, but..." / "No, and..." 원칙).

## 규칙
- 시간은 서사에 맞춰 자연스럽게 흐른다. 이동/전투/휴식마다 경과.
- 플레이어 행동을 공정 판정
- 모든 파티원을 챙기는 전개

## 파티 요약 읽는 법
파티 요약에는 각 플레이어의 Lv, HP/최대, MP/최대, **방어 수치**, 장착 장비, 소지품 최근 3개가 담겨있다. 방어 수치가 높은 플레이어에게는 물리 피해를 좀 더 가볍게, 낮은 플레이어에게는 더 치명적으로 묘사해라. HP 만 보지 말고 방어도 함께 고려할 것.

세계관: 고대 마왕 '볼카르'가 수천 년의 봉인에서 깨어나고 있다. 영웅들은 그의 부활을 막아야 한다."""


# ── 태그 파싱 공통 ─────────────────────────────
HP_PATTERN = re.compile(r"\[([^\]]+?)\s*HP\s*[:：]\s*(\d+)\s*(?:→|->|=>|-)\s*(\d+)\]")
MP_PATTERN = re.compile(r"\[([^\]]+?)\s*MP\s*[:：]\s*(\d+)\s*(?:→|->|=>|-)\s*(\d+)\]")
XP_PATTERN = re.compile(r"\[([^\]]+?)\s*XP\s*\+\s*(\d+)\]")
# 아이템 획득 — 효과는 선택 사항 (이름 | 효과)
ITEM_PATTERN = re.compile(r"\[([^\]]+?)\s*획득\s*[:：]\s*([^\]|]+?)(?:\s*\|\s*([^\]]+?))?\]")
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
# 버프/디버프: [이름 버프: 효과명 N턴 | 설명] 또는 [이름 디버프: 효과명 N턴 | 설명]
STATUS_PATTERN = re.compile(
    r"\[([^\]]+?)\s*(버프|디버프)\s*[:：]\s*([^|\]]+?)\s+(\d+)\s*턴(?:\s*\|\s*([^\]]+?))?\]"
)
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
MONSTER_SPAWN_PATTERN  = re.compile(r"\[적\s*등장\s*[:：]\s*([^\]|]+?)\s*\|\s*HP\s*(\d+)\s*\]")
MONSTER_HP_PATTERN     = re.compile(r"\[적\s*HP\s*[:：]\s*([^\]]+?)\s+(\d+)\s*[→>\-]+\s*(\d+)\s*\]")
MONSTER_STATUS_PATTERN = re.compile(r"\[적\s*상태\s*[:：]\s*([^\]|]+?)\s*\|\s*([^\]]+?)\s*\]")
MONSTER_LEAVE_PATTERN  = re.compile(r"\[적\s*퇴장\s*[:：]\s*([^\]]+?)\s*\]")


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


def parse_and_apply_monsters(text: str, monsters: "Dict[str, Monster]") -> List[dict]:
    """몬스터 태그 → `monsters` dict in-place 갱신. 이벤트 리스트 반환.
    이벤트 kind: spawn / hp / status / defeated / leave."""
    events: List[dict] = []

    def _find(raw_name: str) -> Optional["Monster"]:
        # 등장 시 정한 풀네임과 **정확 매칭만** (양방향 부분매칭은 '고블린' vs '고블린 궁수' 오탐 원인).
        # DM 프롬프트에 "풀네임 그대로 재사용" 이 명시되어 있다.
        return monsters.get(raw_name.strip())

    for m in MONSTER_SPAWN_PATTERN.finditer(text):
        name = m.group(1).strip()
        hp = int(m.group(2))
        if name and name not in monsters:
            monsters[name] = Monster(name, hp)
            events.append({"kind": "spawn", "name": name, "hp": hp})

    for m in MONSTER_HP_PATTERN.finditer(text):
        name = m.group(1).strip()
        try:
            new_hp = int(m.group(3))
        except ValueError:
            continue
        target = _find(name)
        if target:
            target.hp = max(0, min(target.max_hp, new_hp))
            events.append({"kind": "hp", "name": target.name, "hp": target.hp, "max_hp": target.max_hp})
            if target.hp <= 0:
                monsters.pop(target.name, None)
                events.append({"kind": "defeated", "name": target.name})

    for m in MONSTER_STATUS_PATTERN.finditer(text):
        name = m.group(1).strip()
        note = m.group(2).strip()
        target = _find(name)
        if target:
            target.status_note = note or None
            events.append({"kind": "status", "name": target.name, "note": note})

    for m in MONSTER_LEAVE_PATTERN.finditer(text):
        name = m.group(1).strip()
        target = _find(name)
        if target:
            monsters.pop(target.name, None)
            events.append({"kind": "leave", "name": target.name})

    return events


def parse_and_apply_xp(text: str, players: Dict[str, "Player"]) -> List[dict]:
    """XP 적립. 한 태그당/한 응답당 상한을 서버가 clamp 한다.
    각 이벤트는 {name, amount, granted, new_level|None, gains|None} 형태 —
    granted 는 clamp 후 실제 적립된 양 (amount 와 다를 수 있음)."""
    events: List[dict] = []
    total_granted = 0
    for m in XP_PATTERN.finditer(text):
        name_field = m.group(1).strip()
        try:
            requested = int(m.group(2))
        except ValueError:
            continue
        # 1) 한 태그당 상한
        per_event = max(0, min(requested, XP_GAIN_MAX_PER_EVENT))
        # 2) 한 응답당 누적 상한
        room_left = max(0, XP_GAIN_MAX_PER_RESPONSE - total_granted)
        granted = min(per_event, room_left)
        if granted <= 0:
            if requested > 0:
                print(f"[XP CLAMP] {name_field!r} requested={requested} granted=0 (already at response cap)")
            continue
        if granted < requested:
            print(f"[XP CLAMP] {name_field!r} requested={requested} → granted={granted}")
        total_granted += granted
        target = _match_player(name_field, players)
        if not target:
            print(f"[XP MISS] no exact player match for {name_field!r} -> tag ignored")
            continue
        lvl_info = target.grant_xp(granted)
        base = {"name": target.name, "amount": requested, "granted": granted}
        if lvl_info:
            events.append({**base, "new_level": lvl_info["new_level"], "gains": lvl_info["gains"]})
        else:
            events.append({**base, "new_level": None, "gains": None})
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


def parse_and_apply_items(text: str, players: Dict[str, "Player"]) -> List[Tuple[str, str, Optional[str], int]]:
    """아이템 획득 파싱. (플레이어명, 아이템명, 효과|None, 수량) 리스트 반환.
    - `[이름 획득: 아이템]` → 수량 1, 효과 미확인
    - `[이름 획득: 아이템 x3]` → 수량 3
    - `[이름 획득: 아이템 x3 | 효과설명]` → 수량 3, 효과 있음
    """
    gained: List[Tuple[str, str, Optional[str], int]] = []
    for m in ITEM_PATTERN.finditer(text):
        name_field = m.group(1).strip()
        raw_item = m.group(2).strip()
        effect = m.group(3).strip() if m.group(3) else None
        item, qty = _split_qty(raw_item)
        if effect and len(effect) > 120:
            effect = effect[:120]
        if not item or len(item) > 40 or qty < 1 or qty > 99:
            continue
        target = _match_player(name_field, players)
        if target:
            # grant_item은 "새로 추가"됐는지 반환. 이미 있는 경우도 '획득' 이벤트로는 알림.
            target.grant_item(item, effect, qty)
            gained.append((target.name, item, effect, qty))
    return gained


def parse_and_use_items(text: str, players: Dict[str, "Player"]) -> List[Tuple[str, str, int, int]]:
    """소모품 사용 파싱. (플레이어명, 아이템명, 사용량, 남은 수량) 리스트 반환."""
    used: List[Tuple[str, str, int, int]] = []
    for m in ITEM_USE_PATTERN.finditer(text):
        name_field = m.group(1).strip()
        raw_item = m.group(2).strip()
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
        # 인벤토리는 {name, effect|None} 딕트 리스트. effect=None이면 "아직 알 수 없음".
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
            snippet = self.custom_portrait[:256].encode("utf-8", errors="ignore")
            h = hashlib.md5(snippet).hexdigest()[:8]
            return f"/portrait/{self._room_id}/{self.player_id}?v={h}"
        return self.portrait_url

    def has_item(self, name: str) -> bool:
        return any(it["name"] == name for it in self.inventory)

    def grant_item(self, name: str, effect: Optional[str] = None, qty: int = 1) -> bool:
        """인벤토리에 아이템 추가. 이미 있으면 수량 누적 (효과도 빈 경우 채움).
        실제로 **새** 아이템 항목이 추가됐으면 True (수량만 늘었으면 False)."""
        if qty < 1:
            qty = 1
        for it in self.inventory:
            if it["name"] == name:
                it["quantity"] = it.get("quantity", 1) + qty
                if effect and not it.get("effect"):
                    it["effect"] = effect
                return False
        self.inventory.append({"name": name, "effect": effect, "quantity": qty})
        return True

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
        stat: 'max_hp' | 'max_mp' | 'attack' | 'defense'.
        증가 규칙: max_hp +5 / max_mp +5 / attack +1 / defense +1."""
        if self.stat_points < 1:
            return None
        delta_map = {"max_hp": 5, "max_mp": 5, "attack": 1, "defense": 1}
        if stat not in delta_map:
            return None
        delta = delta_map[stat]
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
            "equipped": dict(self.equipped),        # 🆕 장착 장비
            "inventory": [dict(it) for it in self.inventory],
            "is_ready": self.is_ready,
            "status_effects": [dict(st) for st in self.status_effects],
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
            "custom_portrait": self.custom_portrait,
            "equipped": dict(self.equipped),
            "inventory": [dict(it) for it in self.inventory],
            "is_ready": self.is_ready,
            "pending_notes": list(self.pending_notes),
            "status_effects": [dict(st) for st in self.status_effects],
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
        p.custom_portrait = d.get("custom_portrait")
        if "equipped" in d and isinstance(d["equipped"], dict):
            for slot, val in d["equipped"].items():
                if isinstance(val, dict):
                    p.equipped[slot] = {"name": val.get("name", ""), "effect": val.get("effect")}
                elif isinstance(val, str):
                    p.equipped[slot] = {"name": val, "effect": None}
        p.inventory = [dict(it) if isinstance(it, dict) else {"name": str(it), "effect": None, "quantity": 1}
                        for it in d.get("inventory", [])]
        p.is_ready = bool(d.get("is_ready", False))
        p.pending_notes = list(d.get("pending_notes", []))
        p.status_effects = [dict(st) for st in d.get("status_effects", []) if isinstance(st, dict)]
        return p


class Monster:
    """전투 중인 적 유닛. DM 태그로 생성/HP/상태/퇴장 관리.
    HP 가 0 으로 떨어지면 자동 제거. 파티 패널 하단 '몬스터' 섹션에 카드로 노출된다."""
    def __init__(self, name: str, max_hp: int):
        self.name = name
        self.max_hp = max(1, int(max_hp))
        self.hp = self.max_hp
        self.status_note: Optional[str] = None

    def to_dict(self):
        return {
            "name": self.name,
            "hp": self.hp,
            "max_hp": self.max_hp,
            "status_note": self.status_note,
        }

    def to_save_dict(self):
        return self.to_dict()

    @classmethod
    def from_save_dict(cls, d):
        m = cls(d.get("name", "?"), int(d.get("max_hp", 1)))
        m.hp = int(d.get("hp", m.max_hp))
        m.status_note = d.get("status_note")
        return m


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
    def __init__(self, room_id: str):
        self.room_id = room_id
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
        self.turn_order: List[str] = []  # player_id 입장 순서
        self.current_turn_index: int = 0
        # 🆕 관전자 — 플레이어 목록/턴오더에 안 잡히지만 브로드캐스트는 받음.
        # {spectator_id: {"name": str, "ws": WebSocket}}
        self.spectators: Dict[str, dict] = {}
        # 🆕 휴면(dormant) 캐릭터 — 나갔지만 파티가 기억함.
        # {original_player_id: {"player": Player, "departed_at": epoch}}
        # 2분 경과하면 새 접속자가 takeover 가능. 그 전에는 원래 player_id 로만 rejoin.
        self.dormant: Dict[str, dict] = {}
        # 🆕 휴면 처리 대기 타이머 — 연결 끊김 후 N초 grace 안에 재접속 못하면 dormant 처리.
        self._pending_dormant_tasks: Dict[str, asyncio.Task] = {}
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
            "owner_id": self.owner_id,
            "started": self.started,
            "current_time": self.current_time,
            "day": self.day,
            "messages": self.messages,
            "chat_log": self.chat_log,
            "narrative_log": self.narrative_log,
            "turn_order": list(self.turn_order),
            "current_turn_index": self.current_turn_index,
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
        room = cls(d["room_id"])
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

    def current_turn_player_id(self) -> Optional[str]:
        if not self.turn_order:
            return None
        return self.turn_order[self.current_turn_index % len(self.turn_order)]

    def advance_turn(self) -> bool:
        """턴을 다음 플레이어로 넘김. 인덱스가 한 바퀴 돌아 0으로 돌아왔으면 True (라운드 완료)."""
        if not self.turn_order:
            return False
        prev = self.current_turn_index
        self.current_turn_index = (self.current_turn_index + 1) % len(self.turn_order)
        return self.current_turn_index == 0 and prev == len(self.turn_order) - 1

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
                text = await llm_complete(DM_SYSTEM_PROMPT, self._llm_slice(), max_tokens=300)
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
                text = await llm_complete(DM_SYSTEM_PROMPT, self._llm_slice(), max_tokens=300)
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
            lines.append(
                f"- {p.name} ({self._race_label(p)} {p.character_class}, Lv{p.level}, "
                f"HP:{p.hp}/{p.max_hp}, MP:{p.mp}/{p.max_mp}, "
                f"공격:{p.attack}, 방어:{p.defense}{eq_str}{inv_str})"
            )
        header = f"[현재 {self.day}일차]\n" if self.day > 1 else ""
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
        if tick_statuses and acting_player_id:
            acting = self.players.get(acting_player_id)
            if acting:
                expired_statuses.extend(acting.tick_statuses())
        hp_affected = parse_and_apply_hp(text, self.players)
        mp_affected = parse_and_apply_mp(text, self.players)
        xp_events = parse_and_apply_xp(text, self.players)       # [{name, amount, new_level, gains}]
        items = parse_and_apply_items(text, self.players)        # [(name, item, effect|None, qty)]
        effects = parse_and_reveal_item_effects(text, self.players)  # [(name, item, effect)]
        equip_effects = parse_and_reveal_equip_effects(text, self.players)  # [(name, equip, effect)]
        uses = parse_and_use_items(text, self.players)           # [(name, item, used, remaining)]
        statuses_applied = parse_and_apply_statuses(text, self.players)  # [{player_name, kind, name, turns, effect}]
        die_max = {"d4": 4, "d6": 6, "d8": 8, "d10": 10, "d12": 12, "d20": 20, "d100": 100}
        dm_dice = [
            {"die": die, "result": result, "max": die_max[die]}
            for die, result in parse_dm_dice(text)
        ]
        monster_events = parse_and_apply_monsters(text, self.monsters)
        self._maybe_update_time(text)
        return {
            "hp_affected": hp_affected,
            "mp_affected": mp_affected,
            "xp_events": xp_events,
            "items": [{"name": n, "item": it, "effect": ef, "quantity": q} for n, it, ef, q in items],
            "item_effects": [{"name": n, "item": it, "effect": ef} for n, it, ef in effects],
            "item_uses": [{"name": n, "item": it, "used": u, "remaining": r} for n, it, u, r in uses],
            "equip_effects": [{"name": n, "equip": e, "effect": ef} for n, e, ef in equip_effects],
            "dm_dice": dm_dice,
            "monster_events": monster_events,
            "statuses_applied": statuses_applied,
            "statuses_expired": expired_statuses,
        }

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
        prompt = (
            f"파티가 모였습니다:\n{self._players_summary()}\n\n"
            "모험을 시작하세요. 볼카르의 부하들이 인근 마을을 습격했다는 소식을 듣고 파티가 출발합니다. "
            "극적인 오프닝 장면을 묘사해주세요. "
            "반드시 맨 첫 줄에 시간대 태그를 넣으세요."
        )
        async with self.lock:
            self.messages = [{"role": "user", "content": prompt}]
            text = await llm_complete(DM_SYSTEM_PROMPT, self._llm_slice(), max_tokens=700)
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
            text = await llm_complete(
                DM_SYSTEM_PROMPT, self._llm_slice(), max_tokens=700
            )
            self.messages.append({"role": "assistant", "content": text})
            tag_events = self._parse_all_tags(text, acting_player_id=player_id)
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

                player_id = player_id or str(uuid.uuid4())[:8]
                room_id = _new_room_code()
                room = GameRoom(room_id)
                rooms[room_id] = room
                current_room = room_id
                room.owner_id = player_id

                print(f"[CREATE_ROOM] name={data.get('player_name')!r} class={data.get('character_class')!r} "
                      f"race={chosen_race!r} animal={animal_ok!r} ratio={ratio_ok!r}")
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

            elif msg == "toggle_ready":
                # 대기실 준비 토글. 전원이 준비되면 자동 시작.
                if not current_room or current_room not in rooms or not player_id:
                    continue
                room = rooms[current_room]
                player = room.players.get(player_id)
                if not player or room.started:
                    continue

                player.is_ready = not player.is_ready
                await room.broadcast({
                    "type": "ready_updated",
                    "players": [p.to_dict() for p in room.players.values()],
                })
                await save_room(room)

                # 전원 준비 완료 + 시작 안 된 상태 → 자동 시작
                if room.players and all(p.is_ready for p in room.players.values()):
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
                        await room.broadcast({
                            "type": "error",
                            "message": f"DM 호출 실패: {type(e).__name__}: {e}",
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
                    await room.broadcast({
                        "type": "game_started",
                        "dm_text": dm_intro,
                        "players": [p.to_dict() for p in room.players.values()],
                        "current_time": room.current_time,
                        "turn_player_id": room.current_turn_player_id(),
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
                # 🆕 플레이어가 UI에서 직접 소지품을 사용. 서버가 수량 감소 + DM에 메모.
                if not current_room or current_room not in rooms or not player_id:
                    continue
                room = rooms[current_room]
                player = room.players.get(player_id)
                if not player:
                    continue
                item_name = str(data.get("item_name", "")).strip()
                if not item_name:
                    continue
                result = player.use_item(item_name, 1)
                if not result:
                    await _send_error(websocket, f"'{item_name}' 을(를) 찾을 수 없습니다.")
                    continue
                # 다음 DM 응답 때 이 사용을 반영하도록 메모 — DM은 효과를 서사에 녹여줌.
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

                # 턴 넘기기 (라운드 완료 여부도 추적)
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
                await save_room(room)  # 💾 핵심 — DM 응답 포함 전체 스냅샷

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

            # 방이 비었고(아무도 접속 중 아님) 시작 안 된 상태면 방 정리
            if not room.connections and not room.started:
                room.players.pop(player_id, None)
                if not room.players and not room.dormant:
                    rooms.pop(current_room, None)
                    delete_save(current_room)


app.mount("/static", StaticFiles(directory="static"), name="static")

if __name__ == "__main__":
    import uvicorn
    game_port = int(os.getenv("GAME_PORT", "8080"))
    uvicorn.run(app, host="0.0.0.0", port=game_port)
