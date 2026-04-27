# TROG CHANGELOG

개별 노트들을 한 파일로 통합. 새 작업은 V{N} 섹션을 맨 위에 추가한다.

---

## V6 — 2026-04-24 (게임 시스템 확장 — 골드·장비/소모품·관망·상태 해제 외)

V5 비판 라운드 직후 들어온 9개 항목 — 일부는 시스템 변경(보장됨), 일부는 DM 프롬프트 가이드(LLM 톤이라 100% 보장 안 됨). 본문에 명시.

### 🪙 신규 시스템 (서버 보장)

- **소지 금액(골드)**. `Player.gold` + 직업별 시작값(전사 50 / 마법사 80 / 도적 70 / 성직자 60). DM 태그 두 가지:
  - `[이름 골드: X → Y]` (절대값, HP/MP 와 일관)
  - `[이름 골드 +N]` / `[이름 골드 -N]` (증감)
  - 음수 보호 — 잔고가 부족하면 0 으로 clamp. 클라 캐릭 패널에 `💰 N G`, 파티 카드 우측에 골드 표시.
- **인벤 아이템 종류 분류** (`kind: consumable | equipment | quest`). DM 태그 확장:
  - `[이름 획득: 강철검 | 무기 | 출혈 +10%]` → 자동 무기 슬롯 장착, 기존 무기 인벤으로 회수
  - `[이름 획득: 사슬 갑옷 | 방어구 | 방어 +4]` / `[이름 획득: 매혹 반지 | 장신구 | CHA 판정 +2]`
  - `[이름 획득: 치유 물약 x3 | 소모품 | HP 30 회복]` (사용 버튼)
  - `[이름 획득: 볼카르 인장 | 퀘스트]` (사용·장착 불가)
- **장비 vs 소모품 클라 분기**. 인벤 카드에 종류 뱃지(🛡 장비 / 🍶 소모품 / 📜 퀘스트). 버튼:
  - 소모품 → "사용" (2-클릭 confirm)
  - 장비 → "장착" (1-클릭 confirm, 슬롯 자동 추론) + 기존 장비 자동 인벤 회수
  - 퀘스트 → 버튼 없음, 사용/장착 거부
  - 종류 모를 때 사용자가 그냥 "사용" 누르면 서버가 `use_item_confirm` 회신 → 클라 confirm → action='equip' 재전송.
- **상태 효과 즉시 해제 태그**. 이전: DM 이 "독이 깨끗이 빠져나갔다" 서사를 써도 디버프가 정직하게 턴 감소만 → 서사·수치 어긋남.
  - `[이름 상태 해제: 효과명]` / `[이름 디버프 해제: 독]` / `[이름 버프 해제: 축복]`
  - 파서 `parse_and_clear_statuses` 가 즉시 status_effects 에서 제거. `statuses_cleared` 이벤트로 클라 토스트.
- **본인 턴 패스 / 관망(LLM 진행)**. 빠른 행동 줄에 두 개 추가:
  - `🌫 관망/진행`: LLM 호출, 액션 텍스트는 "(잠시 행동을 멈추고 주변 상황을 지켜본다…)" 자동 → DM 이 장면을 한 단계 진척.
  - `⏭ 내 턴 패스`: LLM 호출 없이 본인 턴만 다음 사람으로 (방장 skip 과 달리 **본인만** 자기 턴 넘김 가능 — 인질극 방지).
- **모바일 클릭 효과 토글**. 인벤 카드 자체를 탭하면 `.show-effect` 클래스로 효과 펼침. 데스크톱은 `:hover` 그대로 유지.

### 🎭 DM 프롬프트 가이드 (LLM 톤 — 보장은 못 함, 명시는 강화)

- **자해 행동 시 본인에게도 디버프 부여 명시**. 예: "도적이 자기 독 단도를 핥음 → 본인에게 `[도적 디버프: 독 2턴 | 매 턴 HP -3]`". 우매한 자유는 우매한 결과를.
- **종족별 발성**. 적 비명·죽음 묘사를 그 생물의 발성에 맞춤. "끄아악!" 대신 개구리 "꽉-!", 늑대 "캥!", 새 "꺽!", 곰 "그르렁-", 쥐 "찍-!", 뱀 "쉬이익-…" 등.
- **인원수 난이도 스케일링**. `_players_summary` 첫 줄에 `[파티 N명 · 평균 LvX.X · 일차]` 헤더 박음. 1~2 명 / 3~4 명 / 5+ 명 별 적 강도 가이드 제공. 평균 Lv +1 마다 적 HP +20% / 적 수 +1.
- **마을·도시·여관 도착 시 선택지 유도**. 시야에 들어오는 시설 2~4개 가볍게 나열, 거리 소문 한 토막, 게시판 의뢰 한 줄. "무엇을 하시겠습니까?" 같은 직접 질문 금지.
- **골드 가이드** — 가격 범위(빵 1~3, 평범한 무기 30~80, 좋은 장비 200+, 마법 두루마리 500+).

### 🔌 신규·변경 WS 메시지

| 방향 | Type | 비고 |
|---|---|---|
| C→S | `pass_turn` | 본인 턴 그냥 넘김 (LLM X) |
| C→S | `linger_action` | 관망 — LLM 호출, 자동 액션 텍스트로 process_action 경유 |
| C→S | `use_item` (확장) | `action: 'use'\|'equip'`, `slot?` 필드 추가 |
| S→C | `use_item_confirm` | "이건 장비입니다. 장착할까요?" — 클라 confirm 후 action='equip' 재전송 |
| S→C | `item_equipped` | 장착 결과. replaced 필드에 회수된 기존 장비명 |
| S→C | `dm_response.events.gold_events` | `[{name, gold, delta}]` |
| S→C | `dm_response.events.statuses_cleared` | `[{player_name, name}]` |
| S→C | `dm_response.events.items[*].kind/slot/auto_equipped/replaced` | 기존 items 이벤트 확장 |

### 🧪 검증

- `python -m py_compile trog/main.py` ✅
- `node --check trog/static/game.js` ✅
- 스모크: 골드 시스템(set/delta/음수 보호) / 상태 해제(태그·alias) / 아이템 종류 분류 / 자동 장착 / 명시 장착(인벤→슬롯+회수) / 소모품 사용 / 파티 헤더 / `_parse_all_tags` 통합 — 모두 통과

### ⚠ 한계 (LLM 의존 항목)

- 자해 행동 디버프 / 종족별 울음소리 / 마을 선택지 유도 / 인원 난이도 스케일링 — 전부 시스템 프롬프트 가이드. 모델이 따라줄 확률을 높일 뿐 100% 보장 X. 만약 DM 이 자주 무시하면 가이드 문구를 더 단호하게(`반드시`, `금지` 등) 강화해야 함.

---

## V5 — 2026-04-24 (비판적 리뷰 라운드 — 게임성·보안·견고성 전면 정비)

게임 시스템 / 태그 파싱 / 보안 / 운영의 20여개 허점을 흐름 따라 훑은 뒤 일괄 수정. 상세 근거는 루트의 [`CRITICAL_REVIEW_V4.md`](../../CRITICAL_REVIEW_V4.md) 참조.

### 🎮 게임성 모순 제거 (T1)

- **레벨업 풀회복 → 비율 유지**. `Player.grant_xp` 가 더 이상 `hp = max_hp` 덮어쓰기 하지 않고, **증가분(+10)만 현재 HP 에 더한다**. 이전에는 "간신히 살아남은 승리 후 레벨업" 서사가 풀피로 덮어써져 모순이었고 HP 1 까지 몰아놓고 레벨업 = 풀피 치트 루프가 가능했음.
- **시간 역행 방지를 "하루 경과" 로 해석**. 이전: 심야(🌌)→새벽(🌅) 전이가 역행으로 판정돼 영구 심야 고착. 지금: `GameRoom.day` 를 두고 ordinal 이 내려가면 day+1 로 증가 — 자연스러운 하루 경과가 가능. `current_time` dict 에도 `day` 복제돼 브로드캐스트·서사 로그에 반영.
- **버프/디버프 틱 = 행동 당사자 1명만**. 이전: 매 DM 응답마다 파티 전원 tick → 4인 파티에서 "3턴 버프" 가 1라운드도 못 버텼음. 지금: `_parse_all_tags(acting_player_id=...)` 로 해당 플레이어의 상태만 감소. "3턴 = 본인 차례 3번" 직관으로 복귀.
- **연결 끊김 이벤트 통합**. 이전: 끊기자마자 "턴 스킵 공지" → 90초 후 "파티 이탈 공지" 로 2개 이벤트가 갈라져 혼란. 지금: grace 90초 동안 아무 공지도 안 내보내고, dormant 이동 시점에 턴 스킵 + 이탈 + DM 내러티브를 한 묶음으로 발송.
- **custom_portrait 을 `/portrait/{room}/{pid}` 라우트로 서빙**. 이전: data URL (최대 ~1.4MB) 이 매 DM 응답 payload 에 포함 → 4인 파티 커스텀 그림이면 턴마다 ~5MB WebSocket payload. 지금: 브로드캐스트에는 URL만 실리고 이미지는 별도 1회 요청. 모바일 네트워크 부담 급감 + save 파일도 가벼워짐.

### 🔒 보안·신뢰성 (T2)

- **주사위 서버 난수화**. 이전: 클라가 `Math.random()` 계산한 `result` 를 서버가 범위 검증만 하고 중계 → DevTools 로 항상 20 찍기 가능. 지금: 클라는 `{type:'dice_roll', die}` 만 보내고 서버가 `random.randint` 로 굴려 응답 브로드캐스트.
- **XP 서버 상한**. 태그 당 최대 200, 한 응답 전체 누적 최대 500 으로 clamp. 악용·프롬프트 주입 대응.
- **부분매칭 오탐 제거**. `_match_player` / 몬스터 `_find` / `reveal_equipment_effect` / `reveal_item_effect` 가 **정확 매칭만** 수행. 이전: '철수' / '김철수' 공존 시 접두사 매칭 오탐, '고블린' / '고블린 궁수' 공존 시 HP 태그가 엉뚱한 놈에 적용되는 문제.
- **장비/아이템 효과 태그에 플레이어 지목 포맷 도입**. `[장비 효과: 플레이어 | 장비 | 효과]` / `[아이템 효과: 플레이어 | 아이템 | 효과]`. 생략형은 **해당 장비/아이템을 든 플레이어가 파티 내 정확히 1명** 일 때만 적용 (2명 이상 = ambig, 무시 + 로그).
- **`_players_summary` 에 `공격` / `방어` 노출**. DM 이 방어 수치를 인지해 물리 피해 서술에 반영. 이전: defense 가 프롬프트에 안 실려 stat_points 몰빵해도 서사는 그대로.
- **LLM 호출 타임아웃 30초**. `asyncio.wait_for` 로 `llm_complete` 감쌈. 초과 시 `LLMTimeoutError` 를 던져 `process_action` 호출자가 "응답 지연" 에러만 브로드캐스트하고 턴은 넘기지 않음 — 방 전체가 블록되는 사태 방지.
- **플레이어 action 의 `[` `]` 전각 치환**. `sanitize_player_action` 이 대괄호를 전각(`〔` `〕`) 으로 치환 → 플레이어가 액션 문자열에 태그 형식을 심어 DM 이 흉내내도록 유도하는 프롬프트 주입 완화. 서버 파서는 ASCII 만 인식.

### 🦊 수인 종족 UX (T3)

- **프롬프트를 5단 버킷으로 세분화** (경계: 25/45/55/70). 이전: 3단(33/66)이라 0~33 이 같은 그림, 33→34에서 급변. 지금: 슬라이더 변화가 그림에 자연스럽게 반영됨.
- **비율 범위 10~90 로 제한**. 0(=인간) / 100(=짐승) 은 수인 정체성 모순이라 서버에서 거부. 슬라이더 UI min/max 도 동일.
- **모든 버킷 프롬프트에 `"dark fantasy CRPG hero, still a humanoid hero (not a furry animal character)"` 를 박음**. 이전: 70%+ 구간에서 `"{animal}folk beastkin"` 단어 때문에 Flux 가 퍼리 아트 방향으로 치우쳤음. 지금은 인간형 영웅 톤 유지 지시를 함께 박아 발더스게이트 톤과 충돌 완화.
- **silent fallback 제거**. 지원 안 하는 동물명 보내면 더 이상 조용히 늑대로 바꾸지 않고 `"지원하지 않는 동물: X. 선택 가능: 늑대/여우/호랑이/고양이/토끼/곰"` 에러 반환. `validate_race_params` 헬퍼로 입구에서 검증.

### 🏛 운영·엣지 (T4)

- **Dormant 24시간 자동 만료** (`DORMANT_EXPIRE_SEC`). `expire_dormant()` 가 `_dormant_summary` 조회 / save 로드 시 자동 실행. 메모리·네트워크 누수 차단.
- **`force_unlock_dormant` 2단계 확인**. 1차 요청은 `dormant_unlock_pending` 이벤트로 대상 정보 회신 + 30초 대기, 2차 요청(`confirm:true`) 에만 실제 해제. 방장이 잠깐 끊긴 플레이어 캐릭터를 임의로 다른 사람에게 넘기는 악의적 시나리오 차단.
- **끊긴 플레이어가 방장 되는 문제 해소**. `_pick_new_owner` 가 `room.connections` 에 있는 후보만 선택. 후보 전무면 `owner_id = None` + `owner_vacant` 브로드캐스트 → 이후 입장·재입장자가 자동 위임(`_claim_vacant_owner`).
- **Save 스키마 version 체크**. `SAVE_SCHEMA_VERSION = 2`. `from_save_dict` 가 버전 미스매치 시 WARN 로그 + best-effort 복원. 구버전 수인 ratio 0/100 저장본은 10/90 으로 자동 clamp 하여 로드 실패 방지.

### 🧹 정리

- 도적 "쌍단검" 기본 effect 가 `weapon_options` 첫 항목의 effect 로 자동 매핑 — 이전: 명시 선택 시만 effect 표시라 같은 무기인데 플레이어마다 effect 존재 여부가 달랐음.
- `stats.get("mp", 50)` 폴백 제거 (dead code — 모든 직업이 mp 키 보유).
- 새 상수: `ACTION_MAX_LEN`, `XP_GAIN_MAX_PER_EVENT`, `XP_GAIN_MAX_PER_RESPONSE`, `DORMANT_EXPIRE_SEC`, `LLM_TIMEOUT_SEC`, `BEASTFOLK_RATIO_MIN/MAX`, `SAVE_SCHEMA_VERSION`.

### 🔌 신규·변경 WS 메시지

| 방향 | Type | 비고 |
|---|---|---|
| S→C | `dormant_unlock_pending` | force_unlock 1차 응답. confirm:true 재전송 유도 |
| S→C | `owner_vacant` | 연결된 후보 없어 방장 공석 — 다음 입장자 자동 위임 |
| C→S | `force_unlock_dormant` | `confirm: bool` 플래그 필수 (1차 false, 2차 true) |
| C→S | `dice_roll` | `result` 필드 무시됨 (서버가 굴림) |

### 🧪 검증

- `python -m py_compile trog/main.py` ✅
- `node --check trog/static/game.js` ✅

---

## V3 — 2026-04-23 (creativity + ops hardening)

### 게임 시스템
- **XP / 레벨업 시스템 가동**
  - DM이 `[이름 XP +N]` 태그를 찍으면 서버가 자동 적립
  - 임계값 달성 시 자동 레벨업 (Lv2: 100, Lv3: 250, Lv4: 450, Lv5: 700, Lv6: 1000 …)
  - 레벨업 보상: `max_hp +10`, `attack +2`, 현재 HP 풀회복
  - 클라이언트에서 보라→골드 XP 바로 진행도 시각화, 레벨업 토스트 + 캐릭터 패널 플래시
- **아이템 획득 시스템**
  - DM이 `[이름 획득: 아이템명]` 태그를 찍으면 플레이어 인벤토리에 추가
  - 캐릭터 패널에 소지품 칩 목록으로 표시, 파티 요약에도 최근 3개 노출
  - 중복 획득 자동 필터, 이름 40자 초과 오탐 가드
- **창의력 장려 프롬프트 추가** (`DM_SYSTEM_PROMPT`)
  - "Yes, but... / No, and..." 원칙 명시 — 실패해도 이야기가 전진
  - 엉뚱한 시도에 흥미로운 결과를 주도록 지시
- **커스텀 퀵액션**
  - 기본 5개 버튼(탐색/대화/공격/치료/매복) 아래에 사용자 정의 행동 최대 6개
  - 라벨 + 이모지 + 실제 보낼 텍스트 지정. 로컬 저장
  - 우클릭으로 삭제

### DM 품질 & 서사
- **시간 역행 방지** — 시간대마다 ordinal(0~5) 부여, 이전보다 작은 값이면 현재 시간 갱신 무시
- **파티 요약에 레벨·인벤토리 노출** — DM이 캐릭터 성장 상태를 인지하고 응답에 반영 가능

### 견고성 / 운영
- **🔴 보안: `.env.example`에서 실키 제거** (V2까지 실제 API 키가 예제 파일에 노출돼 있었음)
- **`.gitignore` 신규** (`trog/`와 저장소 루트 양쪽)
- **`requirements.txt` 버전 범위 고정** — major 버전 업으로 인한 surprise break 방지
- **메시지 히스토리 트림** — 플레이어당 방당 최대 50개만 메모리 유지 (LLM에는 최근 20개 전송, 기존 동일)
- **레이트리밋** — 플레이어당 행동 3초 쿨다운. LLM 호출 폭탄 방지
- **방 코드 충돌 방지** — 생성 시 기존 방 코드와 비교, 최대 50회 재시도
- **자동 캐시버스터** — 서버 기동 시각을 `?v=` 토큰으로 주입. 수동 `?v=3` bump 불필요
- **행동 입력 길이 상한 400자** — 과도한 토큰 소비 + 프롬프트 주입 완화
- **모델 기본값 정리** — `claude-sonnet-4-6`으로 통일 (`.env.example`)

### 코드 리팩터
- `_match_player` 공통 헬퍼 추출 (HP/XP/아이템 파서가 공유)
- `parse_time_tag`가 ordinal 포함 dict 반환
- `process_action` 시그니처 변경: `(player_id, action)` → `(dm_text, tag_events)`. 호출 측(`ws_endpoint`)에서 events를 브로드캐스트 페이로드에 포함

### 검증
- 문법 검사 (`python -m ast` / `node --check`) 통과
- 스모크 테스트 통과: 태그 파싱, 시간 역행, 레벨업 보상, 방 코드 다양성, HTTP 응답 캐시버스터 주입

---

## V2 — 2026-04-22 (톤 개선 + 시간대 표시)

- **DM 프롬프트 개편** — 플레이어 이름 뉘앙스("허접" vs "강철왕") 톤 반영 지시, 종족 특성 적극 활용, NPC 대사 사투리 허용
- **시간대 표시** — 응답 첫 줄 `[🌅 새벽]` 등 강제, 서버가 파싱해 `GameRoom.current_time` 저장, 브로드캐스트 페이로드에 포함
- **게임 중 그림 그리기 버튼 추가** — 대기실뿐 아니라 `char-panel` 하단에도
- **`?fresh=1` URL 파라미터** — localStorage 세션 강제 초기화
- **시간 파싱 키워드 폴백** — 이모지 태그 못 찾으면 "심야/황혼" 등 키워드로 추정
- **방 나가기 버튼** — `char-panel` 하단 경고색 버튼
- **수동 캐시버스터** `?v=2` → `?v=3` (V3에서 자동화됨)

## V1 — 2026-04-22 (비동기 + 멀티플레이 복원력)

- **비동기 LLM 호출** — `AsyncOpenAI` / `AsyncAnthropic` + `asyncio.Lock`으로 방별 순차 호출
- **WebSocket 재연결** — `trog-session` localStorage(2시간 유효) + 3초마다 `rejoin_room` 자동 시도
- **에러 복원력** — LLM 실패해도 연결 유지, `error` 메시지만 전달
- **HP 파싱** — `[이름 HP: X → Y]` 태그 적용, max_hp로 clamp
- **커스텀 캐릭터 그림** — 384×384 캔버스, 10색 팔레트, JPEG 70% 압축 (최대 1MB), WebSocket 브로드캐스트
- **종족 시스템** — 8종족 랜덤 배정 + 프롬프트에 포함, 초상화에 외모 특징 반영
- **방장 권한** — `owner_id` 검증, `start_game` 방장만

## wrapper 통합 히스토리 (2026-04-21)

`trog` → `claude-code-openai-wrapper` → Claude Code CLI 구독 경로 구축 과정의 주요 이슈.

- `.env` 오타 `WRAPPER_MODEL=model=claude-...` → 접두사 중복 제거
- `.env` 오타 `ANTHROPIC_API_KEY=y sk-...` → 선두 `y` 제거
- **Windows asyncio subprocess `NotImplementedError`** — uvicorn이 `WindowsSelectorEventLoopPolicy`를 강제 → `claude_agent_sdk`의 subprocess 미지원. 해결: `run_win.py`에서 `WindowsProactorEventLoopPolicy` 수동 설정 후 `uvicorn.Server.serve()` 직접 호출
- **세부 에러 원본:** `../WRAPPER_FIX_NOTES.md` 참조 (보존)

---

## 원본 노트 (아카이브)

루트의 `FEATURE_UPDATE_NOTES.md`, `FEATURE_UPDATE_V2_NOTES.md`, `WRAPPER_FIX_NOTES.md`, `FEATURE_UPDATE_V3_NOTES.md`가 원본. 세부 스크린샷·의사결정 맥락이 필요하면 그쪽 참조.
