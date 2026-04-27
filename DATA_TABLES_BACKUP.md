# 📦 trog 데이터 테이블 백업 (소실 방지용)

**작성일**: 2026-04-28
**목적**: 코드 리팩터/실수로 데이터 테이블 날아갈 시 이 문서로 복원 가능

---

## 1. CLASS_STATS — 직업 4종 (`main.py:284-360`)

| 직업 | HP | MP | ATK | DEF | Gold | Emoji | 무기 | 방어구 | 장신구 |
|---|---|---|---|---|---|---|---|---|---|
| 전사 | 120 | 30 | 15 | 10 | 50 | ⚔️ | 녹슨 장검 | 가죽 흉갑 | 낡은 방패 |
| 마법사 | 70 | 150 | 22 | 5 | 80 | 🔮 | 견습생의 지팡이 | 수련자 로브 | 작은 마법서 |
| 도적 | 90 | 60 | 18 | 7 | 70 | 🗡️ | 쌍단검 | 어두운 가죽 갑옷 | 도둑의 밧줄 |
| 성직자 | 100 | 120 | 10 | 12 | 60 | ✨ | 축복받은 철퇴 | 성스러운 사제복 | 성표 |

### 직업별 무기 옵션 (`weapon_options`)
**전사**: 녹슨 장검 🗡️ / 거대한 양손도끼 🪓 / 뾰족한 창 🔱
**마법사**: 견습생의 지팡이 🪄 / 서리 오브 🔮 / 화염 완드 🔥
**도적**: 쌍단검 🗡️ / 짧은 석궁 🏹 / 독 바른 단도 🧪
**성직자**: 축복받은 철퇴 🔨 / 성스러운 원드 🪄 / 은빛 망치 🔆

---

## 2. RACES — 종족 9종 (수인 포함, `main.py:363-410`)

| 종족 | Emoji | 설명 |
|---|---|---|
| 인간 | 🧑 | 균형잡힌 종족. 다재다능하고 어디든 적응한다. |
| 엘프 | 🧝 | 고귀한 숲의 수호자. 우아하고 지적이다. |
| 드워프 | 🧔 | 산악의 장인. 강인하고 고집스럽다. |
| 하플링 | 🧒 | 작은 방랑자. 민첩하고 행운이 따른다. |
| 오크 | 👹 | 강대한 전사 종족. 야성과 힘의 화신. |
| 티플링 | 😈 | 악마의 피가 흐르는 자. 매혹적이고 위험하다. |
| 드래곤본 | 🐉 | 용의 후예. 고대의 피를 잇는다. |
| 놈 | 🧙 | 기괴한 발명가. 호기심이 생명이다. |
| 수인 | 🦊 | 인간과 짐승 사이의 혈통. 동물과 비율은 직접 선택한다. |

---

## 3. BEASTFOLK_ANIMALS — 수인 동물 6종 (`main.py:416-453`)

각 동물 5단 비율 묘사 (low/mid1/mid/mid2/high — 10~90 슬라이더로 매끄러운 변화)

| 동물 | Emoji | name_en |
|---|---|---|
| 늑대 | 🐺 | wolf |
| 여우 | 🦊 | fox |
| 호랑이 | 🐯 | tiger |
| 고양이 | 🐱 | cat |
| 토끼 | 🐰 | rabbit |
| 곰 | 🐻 | bear |

- `BEASTFOLK_RATIO_MIN = 10`, `BEASTFOLK_RATIO_MAX = 90`
- 0% (=인간) / 100% (=짐승) 은 정체성 모순이라 금지

---

## 4. SCENARIOS — 시나리오 카탈로그 (`main.py:1045-1260`)

| ID | 이름 | 톤 |
|---|---|---|
| volkar | 볼카르의 부활 | 어둠의 신 봉인 해제 |
| dragon | 카르녹테스의 황금 공물 | 늙은 용과의 외교/대결 |
| plague | 에벤하임의 검은 역병 | 병리·미스터리 |
| masquerade | 시간의 오팔 가면무도회 | 스토리·사회적 긴장 |
| (...) | (...) | (...) |

`DEFAULT_SCENARIO_ID = "volkar"`

(전체 시나리오 수와 세부 설정은 main.py 직접 참조 — 너무 길어서 표로 안 나열)

---

## 5. ABILITY_KEYS — DND 6 능력치 (`main.py:469-479`)

| 영문 | 한글 |
|---|---|
| strength | 근력 (STR) |
| intelligence | 지능 (INT) |
| wisdom | 지혜 (WIS) |
| dexterity | 기교 (DEX) |
| charisma | 매력 (CHA) |
| constitution | 건강 (CON) |

`LEVELABLE_ABILITIES` = (STR/INT/WIS/DEX/CON) — **CHA 는 생성 시 고정**, 레벨업으로 못 올림

---

## 6. RACE_PROMPT — 클라이언트 측 종족 영문 키워드 (`game.js:2771`)

```js
const RACE_PROMPT = {
  '인간': 'human hero, determined eyes',
  '엘프': 'pointed-ear elf, graceful features, ethereal',
  '드워프': 'stocky dwarf, braided beard, rugged',
  '하플링': 'small halfling, nimble, curly hair',
  '오크': 'muscular orc, protruding tusks, green-tinged skin',
  '티플링': 'tiefling with curving horns, reddish-purple skin, glowing amber eyes',
  '드래곤본': 'dragonborn, reptilian scaled face, draconic snout',
  '놈': 'tiny gnome inventor, wild hair, bright curious eyes',
};
```

씬 이미지 폴백 prompt 빌더에서 파티 구성 키워드로 사용.

---

## 7. 시간대 태그 (`main.py:1903~`)

```python
TIME_PATTERN = r"\[(🌅|☀️|🌞|🌆|🌙|🌌)\s*([^\]]+?)\]"
TIME_ORDER = {"🌅": 0, "☀️": 1, "🌞": 2, "🌆": 3, "🌙": 4, "🌌": 5}
```

폴백 키워드:
- 🌅 새벽: 새벽, 동틀, 여명, 이른 아침
- ☀️ 아침: 아침, 오전, 햇살
- 🌞 정오: 정오, 한낮
- 🌆 황혼: 황혼, 저녁, 노을, 해질녘, 석양
- 🌙 밤: 밤, 어둠이 내린, 달빛
- 🌌 심야: 심야, 한밤, 자정, 새벽 1~3시

---

## 8. SCENE_PATTERN (`main.py 시간 태그 섹션 근처`)

```python
SCENE_PATTERN = re.compile(
    r"\[🎬\s*SCENE\s*[:：]\s*([^\]]{5,400}?)\]",
    re.IGNORECASE,
)
_SCENE_STYLE_SUFFIX = (
    "dark fantasy CRPG illustration, Baldur's Gate 3 concept art style, "
    "painterly digital oil painting, cinematic moody lighting, atmospheric, "
    "highly detailed environment, no text, no letters, no words, no logo, no watermark"
)
```

---

## 복원 절차 (만약 일부가 날아간 경우)

1. 이 문서에서 해당 dict/list 의 원형 확인
2. `main.py` 의 해당 라인 근처에 그대로 복사
3. 들여쓰기·임포트 (`re`, `urllib.parse`, `hashlib` 등) 확인
4. 서버 재시작 → 정상 동작 검증
