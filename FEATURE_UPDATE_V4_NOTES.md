# 🎲 TROG — Feature Update V4 Notes

**작성일**: 2026-04-23
**대상 범위**: `trog/main.py` · `trog/static/index.html` · `trog/static/game.js` · `trog/static/style.css`
**버전 흐름**: V3 대비 6대 신규 기능 + 모바일 최적화 + dormant(휴면) 캐릭터 시스템

---

## 📋 한 줄 요약

> DM 주사위가 파묻혀 안 보이던 문제를 고치고, 마력(MP) / 장비 3슬롯 / 관전자 모드 / 게임 중 강퇴·턴 스킵 / 모바일 레이아웃을 추가했다. 큰 건: **파티원이 나가도 2분 안에 돌아오면 그대로 이어가고, 2분이 지나면 다른 사람이 그 캐릭터의 장비·레벨·인벤을 전부 물려받아 이어갈 수 있다** — 퇴장·복귀 순간을 DM 이 서사시적으로 연출.

---

## 🔥 신규 기능 총정리

### 1) DM 주사위 가시화 🎲

**이전 문제**: DM 이 판정 주사위 `[🎲d20: 14]` 같은 걸 굴려도, 클라이언트의 `formatDmBlocks` 가 그 태그를 **본문에서 제거**해버려서 플레이어는 주사위가 있었는지도 모르게 흘러갔다.

**수정 내용**:
- **서버** — DM 시스템 프롬프트에 새 포맷 강제: `[🎲DM d20: X]` (DM 접두사 필수). 플레이어 주사위 포맷 `[🎲d20: X]` 와 구별.
  - [main.py:192-194](trog/main.py#L192-L194) 프롬프트 수정
  - [main.py:244-245](trog/main.py#L244-L245) `DM_DICE_PATTERN` 정규식 추가
  - [main.py:288-300](trog/main.py#L288-L300) `parse_dm_dice()` — 범위 검증까지 수행
  - `_parse_all_tags` 가 `dm_dice: [{die, result, max}]` 리스트를 DM 응답 이벤트에 포함
- **클라** — `renderDmDiceRoll()` 신설. `dm_response` 수신 시 본문보다 먼저 렌더 → 시간 순으로 "DM이 판정 → 그 결과를 본문이 해석" 흐름이 보임.
- **CSS** — `.msg-dice.dm-roll` 에 금색 하이라이트 박스. d20=20 대성공/1 실패에 공용 crit-high/crit-low 톤 재사용.

**결과**: "🎩 던전 마스터 d20 [14] / 20" 형태로 로그에 뚜렷하게 박힘.

### 2) 마력 (MP) 추가 🔮

HP 아래 자리에 **MP 바** 추가. 직업별 초기값이 다르다:

| 직업 | HP | MP |
|---|---|---|
| 전사 | 120 | 30 |
| 마법사 | 70 | **150** |
| 도적 | 90 | 60 |
| 성직자 | 100 | 120 |

- [main.py:74-114](trog/main.py#L74-L114) `CLASS_STATS` 에 `mp` 키 추가
- [main.py:354-356](trog/main.py#L354-L356) `Player` 에 `self.mp`, `self.max_mp` 초기화
- [main.py:238](trog/main.py#L238) `MP_PATTERN` — DM 이 `[이름 MP: X → Y]` 로 기록하면 서버가 파싱·적용
- [main.py:273-282](trog/main.py#L273-L282) `parse_and_apply_mp()`
- [main.py:395-405](trog/main.py#L395-L405) 레벨업 보상에 `max_mp +5` + MP 풀회복
- **클라**: [game.js refreshCharPanel](trog/static/game.js) 에 MP 행 + `.mp-track/.mp-fill` 파란색 그라디언트 바
- 파티 패널의 플레이어 카드도 HP 바 아래 MP 바를 함께 표시
- **DM 시스템 프롬프트**에 MP 태그 사용법 명시

### 3) 스탯 + 장착 장비 (기본템) 🛡

캐릭터 패널에 **장착 중** 섹션 신설. 3슬롯 (무기 / 방어구 / 장신구).

기본템 (class별):
| 직업 | 무기 | 방어구 | 장신구 |
|---|---|---|---|
| 전사 | 녹슨 장검 | 가죽 흉갑 | 낡은 방패 |
| 마법사 | 견습생의 지팡이 | 수련자 로브 | 작은 마법서 |
| 도적 | 쌍단검 | 어두운 가죽 갑옷 | 도둑의 밧줄 |
| 성직자 | 축복받은 철퇴 | 성스러운 사제복 | 성표 |

- [main.py:76-115](trog/main.py#L76-L115) 각 class `equipped` dict 추가
- [main.py:366-372](trog/main.py#L366-L372) `Player.equipped` 초기화
- [main.py:410](trog/main.py#L410) `to_dict` 에 equipped 포함
- [main.py:568-579](trog/main.py#L568-L579) `_players_summary()` 에 장착 정보 포함 → DM 프롬프트가 "이 플레이어는 녹슨 장검을 들고 있음" 을 알고 묘사
- **클라**: `.equipment > .eq-slot` 3개 (⚔️ 🛡 💎 아이콘) 렌더. 빈 슬롯도 "—" 로 뚜렷하게 표시.

### 4) 게임 중 강퇴 & 턴 자동 스킵 🚪

기존에는 대기실에서만 강퇴 가능 + 게임 중 연결 끊김 시 턴이 멈춰버림. 수정:

- **파티 패널** 각 플레이어 카드에 방장 전용 `.pc-kick` ✕ 버튼 (본인/관전자에는 노출 안 됨)
- **방장 전용 턴 스킵 버튼** (액션바 상단): `⏭ 턴 스킵` — AFK 플레이어 대응. DM 호출 없이 턴만 다음 사람으로 넘어간다.
- **서버**: [main.py kick_player](trog/main.py) 핸들러를 게임 중에도 대응하도록 확장 — 강퇴 대상이 현재 턴이면 `turn_auto_skipped` 이벤트 브로드캐스트.
- **서버**: `skip_turn` 메시지 핸들러 신설 — 방장만 호출 가능, LLM 호출 없이 `advance_turn()` 만 실행.
- **서버**: WebSocket `finally` 블록에서 **현재 턴 플레이어가 끊기면 자동으로 `advance_turn` + `turn_auto_skipped` 브로드캐스트**. 게임이 멈추지 않도록.
- **클라**: `turn_auto_skipped` 수신 시 sysMsg 로 "⏭ {이름} 턴 스킵됨 ({이유})" + 턴 인디케이터 갱신.

### 5) 관전자 모드 👁

방 코드만 입력하면 이름·직업 없이 구경만 가능.

- **Entry 화면**: 기존 "새 방 만들기 / 입장" 아래에 `.spectator-row` 추가 — 관전자 입력 필드 + 버튼
- **서버**: `join_as_spectator` 메시지 핸들러 신설. `GameRoom.spectators: Dict[sid, {name, ws}]`
- **서버 broadcast 확장**: 이제 플레이어뿐 아니라 `self.spectators` 도 순회해서 모든 이벤트 중계. 관전자는 읽기 전용.
- **클라**: `isSpectator = true` 상태에서 `sendRaw`, `sendGameChat`, `dice_btn`, `q-btn` 전부 잠금.
- **클라**: `enterSpectatorMode(d)` — entry → 곧바로 game-screen 으로 직행 + 상단 배너 "👁 관전자 모드". 내 캐릭터 패널은 관전자 정보 카드로 대체.
- **CSS**: `body.spectator-mode .action-bar::after` 로 "👁 관전자는 행동할 수 없습니다" 오버레이.

### 6) 파티 채팅 가시성 개선 💬

**이전 문제**: 게임 화면 파티 채팅 영역이 `height:150px` 였지만 실제로 거의 안 보였고, 채팅 input 바인딩이 `DOMContentLoaded` 핸들러에서만 이루어져 스크립트가 늦게 로드되는 환경에선 **Enter 키가 먹히지 않는 버그** 존재.

**수정**:
- `bindGameChatImmediate()` IIFE 로 스크립트 로드 시점에 직접 바인딩 (DOMContentLoaded 의존성 제거)
- `.game-chat-log` 높이: `120px` + `min-height:60px` + `max-height:28vh` — 키보드 올라오면 자동 축소
- 채팅 로그에 투명 배경 추가해 시각적 구분 강화
- 관전자는 채팅 입력창 placeholder 가 "관전자는 채팅할 수 없습니다" 로 변경

---

## 🆕 큰 신규 — Dormant(휴면) 캐릭터 시스템

### 문제 의식

"게임 중에 사람이 나가면, 2분 이상 지났을 때 다른 사람이 이어받아서 시작할 수 있게, 혹은 새 캐릭으로 시작할 수 있게. 나간 사람은 언제든 돌아올 수 있게 서브로 빠지고, DM 이 그 순간을 서사시적으로 묘사해줘."

### 흐름

```
[플레이어 A 가 게임 중 방 나가기]
      ↓
 서버: A 를 dormant 로 이동 (Player 객체 + departed_at 타임스탬프)
      ↓
 DM 이 LLM 호출로 "잠시 사정이 생겨 일행을 떠난다" 서사시 2-3문장 생성
      ↓
 모든 플레이어에게 dm_interlude{kind:"departure"} 브로드캐스트
      ↓
 sysMsg: "👋 A 이(가) 파티를 떠났습니다 (2분 후 이어받기 가능)"

[2분 이내]
 A 의 원래 player_id 로 rejoin → 그대로 복원, 경과시간 기반 "잠시 자리 비웠던 A가…" 내러티브

[2분 경과 후 — 새 사람 B 가 방 코드 입장]
      ↓
 서버 가 takeover 가능한 dormant 목록을 dormant_choice 이벤트로 전송
      ↓
 클라: takeover 모달 — "이 영웅을 이어받기" / "새 캐릭터로 입장"
      ↓
 "이어받기" → takeover_character 메시지 → 기존 Player 의 player_id 만 교체
            → 레벨·HP·MP·장비·인벤·portrait 전부 보존
            → DM 이 "다른 영웅의 모습을 빌려 합류한 새 동료" 서사 생성
      ↓
 "새 캐릭터" → force_new_character:true 로 join_room 재요청 → 일반 신규 합류
            → 이미 시작된 방이면 DM 이 0초 경과 등장 장면 생성
```

### 시간대별 DM 톤 (announce_return 내부 로직)

| 경과 시간 | 톤 키워드 |
|---|---|
| < 5분 | 잠시 자리를 비웠다 다시 합류하는 가벼운 톤 |
| 5–30분 | 한동안 행방이 묘연했던 동료가 숨을 헐떡이며 돌아오는 톤 |
| 30분–2시간 | 오래 걸린 여정 끝에 흙먼지를 털며 귀환한 느낌 |
| 2시간 이상 | 긴 시간 흩어져 있던 영웅이 전설처럼 재등장하는 묵직한 톤 |

### 구현 세부 (서버)

- `GameRoom.dormant: Dict[pid, {player, departed_at}]`
- `GameRoom.dormant_available()` — 2분 (`DORMANT_TAKEOVER_DELAY_SEC = 120`) 경과한 것만 필터
- `GameRoom._move_to_dormant(pid)` — players 에서 제거, turn_order 에서 제거, dormant 로 이동
- `GameRoom.restore_from_dormant(dormant_pid, new_pid)` — dormant 에서 꺼내 players 로 복귀, player_id 교체
- `GameRoom.announce_departure(player)` — LLM 호출 (실패 시 폴백 문장), `dm_interlude{kind:"departure"}` 브로드캐스트
- `GameRoom.announce_return(player, seconds_away, is_takeover)` — 경과 시간별 톤 조절
- **연결 끊김(WebSocketDisconnect) → grace period** (`DISCONNECT_DORMANT_GRACE_SEC = 90`초) 내에 재접속 없으면 자동으로 dormant 처리 (`_pending_dormant_tasks` 로 타이머 관리, rejoin 시 취소)

### 구현 세부 (클라)

- `openTakeoverModal(d)` — dormant 목록을 카드 형식으로 렌더. 각 카드에 초상화 / Lv / HP·MP / 주요 장비 / 인벤 일부 / "N분 전 이탈" 표시.
- "이 영웅을 이어받기" → `takeover_character` 메시지
- "✨ 새 캐릭터로 입장" → `_pendingJoin` 을 `force_new_character:true` 로 재전송
- `dm_interlude` 수신 시 `dmMsg(d.text, true)` 로 일반 DM 내러티브처럼 렌더 + kind 별 sysMsg

### 설계 의도 메모

- **2분 딜레이**는 네트워크 순간 끊김을 takeover 로 오인하지 않기 위한 안전 마진. grace 90초 + takeover 120초 이지만 grace 90초 안에 재접속하면 타이머 취소되어 dormant 로 안 넘어감. 이는 "단순 재접속"을 dormant 경로로 오염시키지 않기 위함.
- **방장 승계** 규칙: dormant 로 이동한 플레이어가 방장이었으면 현재 연결된 플레이어 중 한 명에게 자동 이관.
- **dormant 플레이어 = 방 소멸 방지**: `not room.players and not room.dormant and not room.spectators` 일 때만 방 정리. 혼자 잠깐 나갔다 돌아오는 시나리오에서 방이 사라지지 않음.

---

## 📱 모바일 최적화

### 문제

스크린샷 기준 (폰 세로): 3-컬럼 `210px 1fr 210px` grid 가 폰 화면을 그대로 뚫고 나가서 양옆 패널이 잘림. 파티 패널 / 내 캐릭 패널이 사실상 안 보임.

### 수정 (style.css — `@media (max-width: 780px)`)

- **게임 화면을 단일 컬럼 5행으로** 재배치
  ```
  row1: spectator-banner
  row2: party-panel (max-height: 38vh, 카드 가로 스크롤)
  row3: narrative-panel (1fr)
  row4: char-panel (max-height: 44vh)
  row5: action-bar
  ```
- **파티 카드는 가로 스크롤** (`scroll-snap-type: x mandatory`, 카드 `min-width: 70vw`) — 여러 명이어도 한 화면에 하나씩 스와이프.
- **내 캐릭 패널 압축**: 초상화 `5rem`, 폰트 줄이기, 게임 채팅 90px 고정
- **퀵 액션 / 주사위 버튼**: flex-wrap 허용, 폰트 / 패딩 축소
- **토스트 레이어**: 모바일에선 좌우 margin 확보 (`left: .5rem; right: .5rem`)
- **턴 스킵 힌트 문구 숨김** (공간 확보)
- **엔트리 화면 로고 축소** (`3rem` → 구형 폰은 `2.4rem`)

### 추가 브레이크포인트

- `@media (max-width: 380px)` — 아주 좁은 구형 폰 (갤럭시 S 시리즈 초기 모델 등)
- `@media (max-width: 900px) and (orientation: landscape) and (max-height: 500px)` — 가로 모드 짧은 화면에서 패널 오버플로우 방지

### 추가: Takeover 모달 모바일

- `@media (max-width: 600px)` — 카드가 세로 스택으로 전환, 초상화 중앙 정렬, 버튼 100% 폭

---

## 🐛 에러 수정

### 1. 게임 파티 채팅 Enter 키 무반응

**원인**: `document.addEventListener('DOMContentLoaded', …)` 로 바인딩했는데, `<script>` 태그가 `<body>` 끝에 로드되면 이미 DOMContentLoaded 가 발화한 뒤라 핸들러가 **영원히 호출되지 않음**.

**수정**: IIFE `bindGameChatImmediate()` 로 즉시 바인딩. DOM 이미 준비 완료이므로 안전.

### 2. DM 주사위 결과가 로그에서 소멸

**원인**: `formatDmBlocks` 가 `\[🎲d\d+:\s*\d+\]` 정규식으로 본문에서 주사위 태그를 전부 제거 → 파싱도 안 되니 UI 에도 안 뜸.

**수정**: 서버 측 `DM_DICE_PATTERN` 으로 선제적으로 추출 → `dm_dice` 이벤트로 전달 → 클라가 본문보다 먼저 `.msg-dice.dm-roll` 렌더 → 본문에서는 여전히 태그 제거 (본문이 지저분해지는 걸 방지).

### 3. 플레이어가 방을 나간 뒤 방이 즉시 소멸하는 문제

**원인**: `if not room.players: rooms.pop(...)` — dormant 나 spectator 가 있어도 players dict 만 비면 방 삭제.

**수정**: `not room.players and not room.dormant and not room.spectators` 로 조건 강화. 혼자 잠시 나가도 방은 남아 있어 들어올 수 있음.

### 4. 현재 턴 플레이어가 연결 끊기면 게임이 멈춤

**원인**: finally 블록이 connections 만 제거하고 턴 진행은 안 함.

**수정**: finally 에서 `room.started and current_turn == player_id` 면 `advance_turn()` + `turn_auto_skipped` 이벤트 방송.

### 5. 강퇴 당한 대상에게 참조 시점 버그

**원인**: `target_ws.send_json({..., "by": room.players[player_id].name})` — 이미 방장을 kick 하는 경우는 본인인 target 이 populated 되기 전이라면 KeyError 가능. (현 코드에선 self-kick 이 차단되어 있지만 방어적으로.)

**수정**: `owner_name` 변수로 미리 resolve 한 뒤 사용. 에지 케이스 방어.

---

## 🔌 신규 WebSocket 메시지 타입

### Client → Server

| Type | Payload | 설명 |
|---|---|---|
| `join_as_spectator` | `{room_id, spectator_name}` | 관전자 입장 |
| `takeover_character` | `{room_id, dormant_player_id}` | 휴면 캐릭터 이어받기 |
| `skip_turn` | `{}` | 방장 전용 — 현재 턴 강제 스킵 |
| `join_room` (확장) | `{..., force_new_character}` | takeover 모달에서 "새 캐릭" 선택 시 flag |

### Server → Client

| Type | Payload | 설명 |
|---|---|---|
| `joined_as_spectator` | `{room_id, spectator_id, spectator_name, players, started, current_time, chat_log, last_dm, turn_player_id, spectator_count}` | 관전자 입장 성공 |
| `spectator_joined` | `{spectator_name, spectator_count}` | 타인 관전 시작 알림 |
| `spectator_left` | `{spectator_name, spectator_count}` | 관전자 나감 |
| `turn_auto_skipped` | `{skipped_player_name, reason, turn_player_id}` | 턴 자동 스킵 |
| `dormant_choice` | `{room_id, dormants:[...], pending}` | 휴면 캐릭 선택지 제공 |
| `dm_interlude` | `{kind:"departure"|"return"|"takeover", text, player_name}` | 퇴장/복귀 DM 서사시 |
| `joined_room` (확장) | `{..., took_over, taken_over_name}` | 이어받기 성공 시 플래그 |
| `player_left` (확장) | `{..., went_dormant}` | dormant 로 갔는지 여부 |
| `dice_rolled` → `dm_response.events.dm_dice` | `[{die, result, max}]` | DM 주사위 결과 배열 |

---

## 📂 변경 파일 요약

| 파일 | 라인 증가 (대략) | 변경 |
|---|---|---|
| [trog/main.py](trog/main.py) | ~1015 → ~1320 | MP / equipped / spectator / dormant / DM dice / skip_turn / auto-skip / narrative LLM calls |
| [trog/static/index.html](trog/static/index.html) | ~259 → ~285 | spectator-row / owner-tools / spectator-banner / takeover-modal |
| [trog/static/game.js](trog/static/game.js) | ~1391 → ~1650 | isSpectator / MP & equipped 렌더 / takeover 모달 / interlude 처리 / DM dice 렌더 / skip-turn 바인딩 / owner tools visibility |
| [trog/static/style.css](trog/static/style.css) | ~1588 → ~1900+ | MP 바 / 장비 슬롯 / kick 버튼 / 스킵 버튼 / spectator 배너 / DM dice 스타일 / takeover 모달 / 모바일 반응형 3-단계 |

---

## ✅ 테스트 체크리스트

재기동 (`python trog/main.py`) 후 확인:

**기본 기능**
- [ ] 방 생성 → 직업 4종 모두 MP 초기값이 표시되는지 (전사 30, 마법사 150 등)
- [ ] 캐릭터 패널 "🛡 장착 중" 섹션에 클래스별 기본템 3개가 전부 뜨는지
- [ ] DM 이 주사위 굴리면 `🎩 던전 마스터 d20 [N] / 20` 로그가 본문 위에 나오는지
- [ ] 플레이어 채팅 input 에서 Enter 키로 전송되는지

**관전자 모드**
- [ ] 엔트리 화면 "👁 관전자 모드" 필드에 방 코드 입력 → 바로 game-screen 입장
- [ ] 관전자로 들어온 상태에서 액션 / 주사위 / 채팅 모두 disabled
- [ ] 관전자 입장 시 플레이어들에게 "👁 관전자가 참여했습니다" 알림

**강퇴 / 스킵**
- [ ] 방장 본인 파티 패널 카드 외 다른 플레이어 카드에 `✕` 강퇴 버튼 노출
- [ ] 강퇴 대상이 현재 턴이었으면 자동으로 다음 사람으로 넘어감
- [ ] 액션바 위 `⏭ 턴 스킵` 버튼 (방장 전용)

**Dormant**
- [ ] 게임 중 플레이어 A 가 "방 나가기" → DM 이 2-3문장 퇴장 서사를 뿜는지
- [ ] 1분 후 같은 방 코드로 B 가 입장 시도 → **모달 안 뜸** (아직 2분 안 됨) → 새 캐릭으로 합류
- [ ] 3분 후 B 가 입장 시도 → takeover 모달 뜸 → A 의 초상화·Lv·HP/MP·장비·인벤 표시
- [ ] "이 영웅을 이어받기" → A 의 스탯 그대로 복원 + DM 이 "새 동료가 영웅의 자리를 잇는다" 서사
- [ ] "새 캐릭터로 입장" → 새 Player 생성 + DM 이 "타이밍 맞춰 새 영웅 등장" 서사

**모바일**
- [ ] 폰 세로 (≤780px) 에서 3-컬럼이 단일 컬럼으로 스택
- [ ] 파티 패널 카드가 좌우 스와이프로 넘겨짐
- [ ] 액션 입력 / 퀵버튼 / 주사위 버튼 모두 잘리지 않고 flex-wrap
- [ ] 모달 (takeover 등) 이 화면 뚫고 나가지 않음

**자동 복구**
- [ ] 게임 중 WebSocket 끊기고 90초 후에도 재접속 없으면 dormant 로 자동 이동
- [ ] 그 상태에서 원래 localStorage session 으로 재접속 (rejoin_room) 시도하면 dormant 에서 자동 복구 + 복귀 서사

---

## 🚧 남은 작업 / 향후 검토

- **DM 내러티브 LLM 호출 비용**: 퇴장/복귀마다 LLM 을 한 번씩 호출 → 비용 이슈 시 캐시된 템플릿 + 변수 치환으로 대체 가능
- **Dormant 정리 정책**: 현재 영구 보관 — 방이 살아있는 한 dormant 가 쌓이면 메모리 차지. 24시간 경과 시 자동 만료 등 정책 고려 필요
- **연결 끊김 vs 자발적 퇴장 구분이 UX 측면에서 모호**: grace 90초 이내 재접속해도 다른 플레이어가 "잠시 나갔다 돌아옴" 을 봤으면 좋겠다면 → 현재는 재접속이면 아무 알림 없음. 별도 채널로 "X가 다시 연결됨" 만 sysMsg 하는 것도 검토.
- **관전자 모드에 관전자 수 표시 UI**: spectator_count 는 서버에서 내려주지만 클라 UI 에 "현재 관전자 3명" 배지 없음. 추가 고려.
- **Takeover 시 이름 변경 옵션**: 지금은 원래 이름을 그대로 씀. "이어받는 새 용사가 같은 이름을 쓴다" 는 서사상 어색할 수 있음 — 이어받을 때 이름 변경 입력 추가 고려.

---

## 📝 개발자 메모

이번 업데이트는 "보이는 것 위주" 개선이 많다. 주사위 결과·MP·장비·관전자·강퇴·모바일 전부 **이미 있어야 했는데 UI 레벨에서 드러나지 않던 것들**. 반면 dormant 시스템은 순수 신규 — 세션 지속성 축을 캐릭터 단위로 한 단계 올린 큰 변화. 다음 대규모 업데이트는 아마 "아이템 획득 → 장비 교체" 로직 (현재 inventory 는 추가만 되고 장비 슬롯과 연결 없음) 이 될 것으로 예상.

— *V4 is basically about not losing the player, in every sense.*
