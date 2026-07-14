# [패키지 L] 공동 낙서판 — 기다리는 시간에 다 같이 그림

윤택화 로드맵(2026-07-15 Fable 설계). 작업 폴더: `C:\Users\ui2030\Documents\trpg\trog`

공통 규칙:
- 시작 전 반드시 현재 코드를 먼저 읽어라. 줄번호는 참고용 — **grep으로 재확인**.
- 미커밋 변경(성능·모바일 M-패스·탐색 오버레이) 위에 얹어라 — 되돌리기 금지.
- 기존 스타일 준수. 대규모 리팩터링 금지. git 커밋 금지. IP 고유명사 금지.

설계 의도: "남의 턴 = 죽은 시간" 감사 결론의 놀이 해법. LLM 무관 순수 소셜 기능 —
DM 프롬프트·서사에 일절 연결하지 마라.

## L-1. 서버 (main.py)

1. `GameRoom.doodle: List[dict] = []` — 획 단위 `{"pid", "color", "w", "pts": [[x,y],...]}`.
   좌표는 **0..1 정규화 float**(소수 3자리 반올림 — 대역폭). 상한: 획 1200개 또는 총 포인트 30,000
   초과 시 오래된 획부터 트림(기존 캡 관용구). **save 직렬화에 포함하지 마라** — 휘발성(주석으로 의도 명시).
2. WS 타입 3개(기존 msg 분기 패턴):
   - `doodle_stroke` {color, w, pts}: 검증(pts 2~256개, 각 좌표 0..1, color는 화이트리스트 8색, w는 2단),
     pid 붙여 doodle에 append 후 **보낸 사람 제외** 브로드캐스트. 관전자도 허용(sender_id 사용 — 채팅과 동일 규칙).
     서버측 폭주 방어: 플레이어당 직전 1초 내 10획 초과분은 조용히 drop(레이트리밋 상수).
   - `doodle_clear`: **방장만**. doodle 비우고 브로드캐스트.
   - 입장/재입장/관전 합류 시(joined_room·rejoin_ok·spectator 직접 send_json 지점 — E-2 때 5곳):
     doodle이 비어있지 않으면 `doodle_state` {strokes: [...]} 1회 전송.
3. dormant 이동 시 개별 정리는 불필요(획은 방 소유) — _move_to_dormant 손대지 마라.

## L-2. 클라 (game.js + index.html + style.css)

1. 진입점: 서사 패널 헤더에 🎨 버튼(PC·모바일 공통, 모바일 M-패스 헤더 다이어트와 공존 —
   미니 배지 옆). **dm_pending 수신~해제 동안, 그리고 남의 턴일 때** 버튼에 은은한 펄스 강조(CSS,
   reduced-motion 존중) — "기다리는 동안 그리세요" 신호.
2. 오버레이: 반투명 패널 + 16:10 고정비 캔버스(화면에 맞춰 스케일, devicePixelRatio 대응 —
   기존 초상화 그리기 캔버스(~5935 근처 draw canvas) 관용구 재사용). 구성: 색 8칩·굵기 2단·
   [방장만] 전체 지우기·닫기. 열려 있어도 게임 진행 방해 금지(토스트·턴 전환 시 자동 닫지 않되,
   내 턴이 오면 상단에 "▶ 당신 차례!" 배너 한 줄 표시).
3. 그리기: pointerdown~move~up 로컬 즉시 렌더 → pointerup에 획 전송(60pt 초과 시 균등 다운샘플).
   수신 획은 즉시 그림. doodle_state 수신 시 전체 재렌더. 리사이즈 시 재렌더(정규화 좌표라 가능).
   탭 하이라이트 방지(-webkit-tap-highlight-color: transparent — 탐색 때와 동일).
4. 모바일: 오버레이 전체화면에 가깝게, 캔버스 터치 시 페이지 스크롤 방지(touch-action: none은
   캔버스에만). 키보드 리프트와 무관.
5. 지우개는 만들지 마라 — 색·굵기·전체지우기(방장)로 충분(ponytail). 이름표·커서 공유도 스코프 밖.

## 검증 (전부)
1. py_compile main.py / node --check static/game.js.
2. 신규 _test_doodle.py: 획 검증(포인트 수·좌표 범위·색 화이트리스트)·캡 트림·clear 방장 가드·
   레이트리밋 drop. 회귀: _test_balance, _test_act_progress. trpg conda 파이썬, PYTHONIOENCODING=utf-8.
3. 서버 실동(GAME_PORT=8099) + playwright 2탭(_playtest_ws.py 패턴 또는 브라우저 2컨텍스트):
   A가 그린 획이 B 캔버스에 뜨는지, B 새 합류 시 doodle_state 복원되는지, 방장 아닌 쪽 clear 거부되는지.
   모바일 360×800 스크린샷 1장 + 데스크탑 1장(_shots/). 
4. 서버·브라우저 종료, 테스트 방 saves 삭제, 잔류 프로세스 체크.
5. 구현 전 mcp__codex-bridge__ask_codex 계획 검토, 구현 후 검증.
6. 같은 문제 2회 실패 시 중단하고 상황 보고.
