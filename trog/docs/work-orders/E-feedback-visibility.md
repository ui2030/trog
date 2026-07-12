# [패키지 E] 타격감·가시성 — 본인 HP 연출·진행도 배지·첫 전투 안내

TROG 전체 테스터 감사(2026-07-12) 후속 수정. 작업 폴더: `C:\Users\ui2030\Documents\trpg\trog`

공통 규칙:
- 시작 전 현재 코드 먼저 읽기. 줄번호는 감사 시점 참고용 — **grep으로 재확인**.
- 패키지 A~D 가 먼저 적용됐을 수 있다. 충돌 없이 병합.
- 기존 토스트/태그 파서 관용구 준수. git 커밋 금지.

## E-1. 본인 HP 변화 연출 (game.js + style.css)

문제: `showEventToasts`(~4116-4227)가 hp_affected/mp_affected 를 렌더하지 않는다 — 전투 최중요 숫자(내 피해)가 텍스트 벽에 묻히고, 피격 플래시/흔들림도 없음.

1. showEventToasts 에 hp_affected 렌더 추가 — **본인(myId) 것만**:
   피해 `💔 -12 HP (23/100)` 붉은 토스트 / 회복 `💚 +20 HP (43/100)` 초록 토스트.
   타인 것은 렌더하지 않음(파티 패널 HP 바가 커버). 기존 toast-* 클래스 체계에 맞춰 신설.
2. 본인 피격 시 초상화(캐릭터 패널)와 mini-hud 에 0.4초 붉은 플래시 오버레이
   (.damage-flash 애니메이션 1회). 회복은 초록 0.4초. `prefers-reduced-motion` 존중
   (기존 reduced-motion 블록에 편입).
3. hp_affected 이벤트가 dm_response 외에 monster_turn·explore_progress 등 어느 경로로 오는지
   grep 으로 전부 확인해 동일하게 적용 — 경로별 이벤트 구조가 다르면 결과 보고에 표로.

## E-2. 시나리오 진행도 배지 (main.py + game.js)

문제: 6개 시나리오에 3막(arc) 구조가 있지만 DM 프롬프트 안에만 존재 — 플레이어는 지금 몇 막인지 알 수 없고, "오늘 여기까지"의 자연스러운 중단점을 못 느낀다.

1. DM 시스템 프롬프트(arc 지시부, ~1627-1647)에 태그 규약 추가:
   "막이 전환되는 시점에 정확히 한 번 `[진행: 2막]` / `[진행: 3막]` 태그를 찍어라."
2. 서버: 기존 태그 파서 관용구로 `[진행: N막]` 파싱(N=1~3만 유효, 그 외 무시) →
   `room.current_act` 저장(기본 1, 게임 시작 시 1로 초기화) → 본문에서 태그 제거(strip) →
   dm_response 류 브로드캐스트에 `current_act` 포함. rejoin_ok / joined_room / 관전 응답에도 포함(재접속 복원).
3. 저장/복원: room 직렬화(save_room 스냅샷)에 current_act 포함 — 기존 필드 추가 관례를 따라 하위호환(없으면 1).
4. 클라: 시나리오 뱃지 옆에 "제1막/제2막/제3막" 소형 배지. current_act 수신 시 갱신,
   막 전환 순간엔 토스트 한 줄("📖 제2막 — 이야기가 깊어집니다").
5. LLM 이 태그를 안 찍으면 1막 표시가 유지될 뿐 아무것도 깨지지 않아야 한다(방어적).
6. 파서 단위 테스트 1개(_test_exploration.py 스타일 또는 기존 파서 테스트 파일에 편승): 정상 파싱·범위 밖 무시·본문 strip.

## E-3. 첫 전투 3줄 안내 (game.js)

문제: 도움말 모달은 단축키 레퍼런스뿐 — "왜 내 차례가 아니지?"를 게임 안에서 배울 곳이 없다.

1. 몬스터가 처음 등장(monster 등장 이벤트 최초 수신)했을 때 `localStorage("trog_combat_tut")`
   가 없으면 1회성 안내 표시:
   "⚔ 전투 시작! ① 행동 순서는 민첩(DEX) 순 ② 내 차례에만 행동할 수 있어요 ③ 파티 채팅은 언제든 OK"
2. 형태는 기존 토스트/배너 체계 재사용(새 모달 금지). 탭하면 닫힘 + 8초 자동 닫힘.
   표시 후 localStorage 기록 — 방/세션 불문 1회.

## 검증 (전부 통과해야 완료)
1. py_compile main.py / node --check static/game.js
2. 기존 테스트 회귀(_test_exploration.py, _test_exploration_flow.py, 있으면 _test_balance.py)
   + E-2 파서 신규 테스트 통과.
   trpg conda 파이썬: `& "$env:USERPROFILE\anaconda3\envs\trpg\python.exe"`, PYTHONIOENCODING=utf-8
3. 서버 실동: GAME_PORT=8099 기동 → /health OK → WS 로 joined_room 에 current_act 포함 확인 →
   종료·잔류 프로세스 체크, 테스트 방 saves/*.json 삭제.
4. 구현 전 mcp__codex-bridge__ask_codex 로 계획 검토, 구현 후 검증.
5. 같은 문제 2회 실패 시 중단하고 "Fable 세션으로 가져가시라" 안내.
