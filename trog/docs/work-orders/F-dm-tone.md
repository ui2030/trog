# [패키지 F] DM 성격 프리셋 — 방 만들 때 톤 선택

윤택화 로드맵(2026-07-14 Fable 설계) 1번. 작업 폴더: `C:\Users\ui2030\Documents\trpg\trog`

공통 규칙:
- 시작 전 반드시 현재 코드를 먼저 읽어라. 이 문서의 줄번호는 설계 시점 참고용 — **grep으로 재확인**하고 맹신하지 마라.
- 다른 패키지(G~J) 작업이 먼저/동시에 적용됐을 수 있다. 충돌 없이 병합해라.
- 기존 코드 스타일·태그 파서 관용구 준수. main.py 대규모 리팩터링 금지. git 커밋 금지.
- 커밋·코드에 IP 고유명사(특정 게임·캐릭터명) 금지.

## F-1. 서버: 톤 프리셋 상수 + 방 속성 (main.py)

1. `TONE_PRESETS` 모듈 상수 4종. 각 항목 {label, emoji, block}:
   - `classic` "🏰 정통 판타지" — **현행 톤 그대로** = block은 빈 문자열(주입 안 함). 기본값.
   - `comedy` "🎭 유쾌한 소동" — 가볍고 코믹, NPC 과장·말장난 허용, 위기도 웃음으로.
   - `horror` "🕯 어둠과 공포" — 불길한 암시·긴장 위주. **고어/신체훼손 상세묘사 금지 1줄 포함**.
   - `noir` "🚬 하드보일드" — 건조하고 냉소적, 짧은 문장, 도덕적 회색지대.
   각 block은 4~6줄 한국어 서술 스타일 지시. **반드시 포함할 공통 마지막 줄**:
   "이 톤은 서술 문체에만 적용된다 — 태그 규약·수치 규칙·판정 결과는 기존 규칙 그대로 따른다."
2. `GameRoom.__init__`(~3280대, scenario_id 받는 곳)에 `tone_id: str = "classic"` 추가.
   `to_save_dict`/`from_save_dict`에 직렬화(없으면 "classic" 폴백).
3. `create_room` 핸들러(~6116): 시나리오 검증(~6137)과 같은 패턴으로
   `data.get("tone_id")` 검증 — TONE_PRESETS에 없으면 "classic".
4. 프롬프트 주입: `build_system_prompt(scenario_id)`(1630)에 tone_id 파라미터 추가,
   classic이 아니면 시나리오 블록 뒤에 톤 block 삽입. 호출부 전부 grep해서 room.tone_id 전달.
5. `room_created`/`joined_room`/`rejoin_ok` 응답에 `tone: {id, label, emoji}` 포함
   (E-2 때 직접 send_json 5곳에 명시 주입한 패턴 참고 — 같은 곳들).

## F-2. 클라: 선택 UI + 뱃지 (index.html + game.js)

1. 방 만들기 화면, 시나리오 선택 근처에 톤 선택 칩 4개(라디오 동작, 기본 classic).
   서버 하드코딩 중복 금지 — `/scenarios`처럼 서버가 목록을 주는 기존 방식이 있으면 따라가고,
   없으면 `/scenarios` 응답에 tones를 동봉해 한 번에 받는다.
2. create_room 송신에 `tone_id` 동봉.
3. 대기실·게임 헤더의 시나리오 표시 옆에 톤 뱃지(emoji+label). 난입자·관전자도 보이게
   joined 계열 수신 처리에서 갱신.

## 검증 (전부 통과해야 완료)
1. py_compile main.py / node --check static/game.js
2. 회귀: _test_balance.py, _test_exploration.py, _test_act_progress.py 통과.
   trpg conda 파이썬: `& "$env:USERPROFILE\anaconda3\envs\trpg\python.exe"`, PYTHONIOENCODING=utf-8
3. 서버 실동(GAME_PORT=8099): 방 생성 시 tone_id="horror" 전송 → room_created에 tone 반환 확인,
   LLM 1회 호출해 응답 톤 육안 확인(_playtest_ws.py 패턴) → 서버 종료, 잔류 프로세스 체크, 테스트 방 saves/*.json 삭제.
4. 구현 전 mcp__codex-bridge__ask_codex 로 계획 검토, 구현 후 검증.
5. 같은 문제 2회 실패 시 중단하고 "Fable 세션으로 가져가시라" 안내.
