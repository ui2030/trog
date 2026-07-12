# [패키지 A] 파티가 안 멈추게 — 대기 경험·AFK·몬스터 턴 폴백

TROG 전체 테스터 감사(2026-07-12) 후속 수정. 작업 폴더: `C:\Users\ui2030\Documents\trpg\trog`

공통 규칙:
- 시작 전 반드시 현재 코드를 먼저 읽어라. 이 문서의 줄번호는 감사 시점 기준 참고용 — **grep으로 재확인**하고 절대 맹신하지 마라.
- 다른 패키지(B~E) 작업이 먼저/동시에 적용됐을 수 있다. 충돌 없이 병합해라.
- 기존 코드 스타일·태그 파서 관용구 준수. main.py 대규모 리팩터링 금지. git 커밋 금지(git repo 아님).

## A-1. 대기자 진행 표시 (main.py + game.js)

문제: 남이 행동하면 대기자 화면엔 진행 표시가 전혀 없다. "DM 생각 중"(showDmTyping)은 행동한 본인에게만 뜬다(game.js sendAction 내부, ~934).

1. 서버: player_action 처리에서 LLM 호출 **직전**에
   `{"type": "dm_pending", "acting_player_id": ...}` 를 브로드캐스트(행동자 제외 exclude).
2. 클라: `dm_pending` 수신 시 자기가 행동자가 아니면 showDmTyping 켜기 +
   턴 인디케이터 문구를 "⏳ OO 행동 중 — DM이 서술하고 있습니다…" 로.
   해제는 기존 경로 재사용: dm_response / monster_turn / error 수신 시
   cleanupTransientUiState 가 이미 typing 을 끄는지 확인하고, 안 끄면 해당 케이스에 추가.
3. 스트리밍: `LLM_STREAMING`(main.py ~137, 기본 off)을 켰을 때 릴레이 체인
   (gemini→NVIDIA 계열)에서 정상 동작하는지 서버 실동으로 확인해라.
   - 정상이면: .env.example 에 `LLM_STREAMING=1` 권장값으로 문서화하고 .env 에도 켠다.
   - 스트리밍이 릴레이와 안 맞으면: 끄인 상태 유지하고 dm_pending 표시만으로 마감. 판단 근거를 결과 보고에 한 줄.

## A-2. AFK 자동 턴 스킵 (main.py + game.js)

문제: 연결은 살아있는데 자리 비운 현재-턴 플레이어를 건너뛰는 장치가 서버에 없다(수동 skip_turn/자발 pass_turn/연결 끊김 90초 dormant 뿐). 탭만 열어두면 파티가 무한 대기.

1. 상수: `TURN_AFK_SKIP_SEC = int(os.getenv("TURN_AFK_SKIP_SEC", "120"))`.
2. 턴이 플레이어에게 넘어갈 때마다(advance_turn 등 턴 전환 지점 — grep으로 전부 찾아라)
   room 에 `turn_started_at = time.time()` 기록. 행동 접수(LLM 처리 시작) 시점에도 갱신해
   처리 중 스킵을 방지 — 또는 별도 `_action_in_flight` 불리언 가드.
3. 가벼운 스위퍼(15초 주기 asyncio 태스크, 기존 _room_idle_sweeper 패턴 참고)가 started 방을 돌며:
   - 현재 행동자가 **플레이어**이고(몬스터 턴 제외)
   - 방에 살아있는 연결이 있고, LLM 처리 중이 아니고, 탐색(exploration active) 중이 아니고
   - now - turn_started_at > TURN_AFK_SKIP_SEC
   이면 기존 pass_turn/skip_turn 과 동일 경로로 턴을 넘기고
   `turn_auto_skipped` (reason: "자리 비움 — 시간 초과") 브로드캐스트.
4. 경고: 스킵 30초 전에 해당 플레이어에게만 `turn_afk_warning` {seconds_left:30} 전송.
   클라: 수신 시 눈에 띄는 토스트 "⏰ 30초 안에 행동하지 않으면 턴이 넘어갑니다".
5. 단위 테스트 1개: turn_started_at 을 과거로 조작 → 스킵 판정 함수가 True, 행동 직후엔 False.
   (스위퍼 로직을 판정 헬퍼로 분리하면 테스트가 쉬움)

## A-3. 몬스터 턴 LLM 실패 폴백 (main.py)

문제: 몬스터 턴 LLM 실패 시 조용히 advance_turn 만 하고 넘어감(~7267) — 적이 아무것도 안 하고 증발한 듯 보여 서사 구멍.

1. process_monster_turn 실패/빈 응답 경로에서, 규칙 기반 폴백 서사 한 줄 생성:
   템플릿 3~4개 중 랜덤. 예: "{이름}이(가) 사납게 으르렁거리며 달려들지만 공격이 빗나간다!",
   "{이름}이(가) 자세를 낮추고 다음 기회를 노린다."
   — HP 태그 없음(상태 변화 0), events {} 로 기존 monster_turn 브로드캐스트 형식 그대로 송출 + narr 로그.
2. 히스토리(room.messages)에도 남겨 DM 이 다음 턴에 맥락을 이어가게 할 것.

## 검증 (전부 통과해야 완료)
1. py_compile main.py / node --check static/game.js
2. _test_exploration.py, _test_exploration_flow.py 회귀 + A-2 신규 테스트 통과.
   trpg conda 파이썬: `& "$env:USERPROFILE\anaconda3\envs\trpg\python.exe"`, PYTHONIOENCODING=utf-8
3. 서버 실동: GAME_PORT=8099 기동 → /health OK → WS 로 dm_pending 브로드캐스트 수신 확인
   (_playtest_ws.py 패턴 참고, 방 생성→2인→행동) → 서버 즉시 종료, 잔류 프로세스 체크, 테스트 방 saves/*.json 삭제
4. 구현 전 mcp__codex-bridge__ask_codex 로 계획 검토, 구현 후 검증.
5. 같은 문제 2회 실패 시 중단하고 "Fable 세션으로 가져가시라" 안내.
