# [패키지 B] 모바일 응급 — 키보드 가림·터치 타깃·safe-area·툴팁

TROG 전체 테스터 감사(2026-07-12) 후속 수정. 작업 폴더: `C:\Users\ui2030\Documents\trpg\trog`

공통 규칙:
- 시작 전 반드시 현재 코드를 먼저 읽어라. 줄번호는 감사 시점 참고용 — **grep으로 재확인**.
- 패키지 A 등 다른 작업이 먼저 적용됐을 수 있다. 충돌 없이 병합.
- 기존 코드 스타일 준수. git 커밋 금지. Playwright 는 이 PC에 미설치 — 브라우저 자동화 시도로 시간 낭비 금지, devtools 확인은 불가하니 정적 근거+Codex 검증으로 마감.

## B-1. 행동 입력창 소프트키보드 가림 (index.html + game.js + style.css) — 최우선

문제: 게임 중 `#game-screen`/`body.in-game` 이 `height:100dvh; overflow:hidden`(style.css ~2681, ~30) 이고 action-bar 는 grid 최하단(fixed 아님). iOS Safari 에선 키보드가 떠도 레이아웃 높이가 안 줄어 입력창이 키보드 뒤로 숨는다.

1. index.html viewport 메타에 `interactive-widget=resizes-content` 추가.
2. game.js: `#action-input`(및 게임 채팅 입력) focus 시 — `window.visualViewport` 가 있으면
   resize/scroll 리스너로 `(window.innerHeight - vv.height - vv.offsetTop)` 만큼
   action-bar(채팅이면 해당 입력 컨테이너)를 `transform: translateY(-N px)` 보정. blur 시 원복+리스너 해제.
   데스크톱 가드: 차이가 50px 미만이면 no-op.
3. 완료 보고에 반드시 포함: "이 항목은 실기기(아이폰/안드로이드) 확인이 필요합니다 —
   폰에서 행동 입력 시 입력창이 보이는지 테스트해 주세요."

## B-2. 터치 타깃 44px (style.css)

문제: dice-btn 모바일 높이 ~20px(~2882), q-btn ~28px(~2875), stat-plus 24×22(~593), inv-equip-btn ~20px(~4790), pc-kick 22×22(~2483) — 손끝보다 작아 오조작.

`@media (pointer: coarse)` 블록 신설(데스크톱 밀도 보존): 위 클래스들(+stat-minus 가 있으면 함께, B-5 의 삭제 ✕ 포함)에 `min-height:40px; min-width:40px`(원형 소형 버튼은 40, 바 형태는 min-height 만) + 터치 여백 padding. 트레이/그리드 줄바꿈이 깨지지 않는지 각 컨테이너 flex-wrap 확인.

## B-3. safe-area 일관화 (style.css)

문제: 탐색 오버레이만 env(safe-area-inset-*) 사용. action-bar 하단·mini-hud(top:10px, ~3431)·edge-tab·#game-screen 상단(padding-top:76px, ~3971)은 미적용 — 노치/홈 제스처바에 UI가 깔림.

- action-bar(전송 버튼 포함 하단 컨테이너): `padding-bottom: max(기존값, env(safe-area-inset-bottom))`
- mini-hud: `top: max(10px, env(safe-area-inset-top))` (left 도 landscape 대비 inset-left)
- edge-tab: 해당 가장자리 inset 반영
- #game-screen 모바일 상단 패딩: `max(76px, calc(60px + env(safe-area-inset-top)))` 형태로 조정

## B-4. hover 전용 툴팁 → 탭 노출 (game.js)

문제: `.eq-slot`(장비 효과), `.monster-speed`, `.stat-locked`, `.stat-equip-bonus` 는 title 툴팁뿐 — 터치에선 영영 안 보임 (style.css ~2436/4577/4611/4610 cursor:help).

위 4종에 위임(delegated) click 핸들러: 요소의 title(또는 data-tip) 텍스트를 기존 토스트(sysToast 계열)로 노출. **주의**: 각 요소에 이미 click 동작이 있는지 grep 으로 먼저 확인 — 있으면 기존 동작 유지하고 같은 탭에서 토스트를 함께 띄우거나, 동작 충돌 시 그 요소는 제외하고 결과 보고에 사유 한 줄.

## B-5. 커스텀 행동 삭제 버튼 (game.js + style.css)

문제: 직접 만든 커스텀 행동 버튼 삭제가 contextmenu(우클릭) 전용(~5085) — 모바일에서 삭제 불가.

커스텀 q-btn 렌더 시 우측에 작은 `✕`(클래스 qa-del) 추가. click 은 stopPropagation 후 confirm → 기존 우클릭 삭제 로직과 **같은 함수** 재사용(중복 구현 금지). 우클릭 경로는 유지.

## B-6. 소형 정리 (style.css)

- `.my-race-box{min-width:320px}`(~935), `.waiting-players{min-width:300px}`(~304) → `min(320px, 100%)` / `min(300px, 100%)` — ≤360px 폰 가로 넘침 방지.
- 극소 폰트 하한: 라운드 트래커 .58rem(~3008)·시나리오 뱃지 .58rem(~4543)·헤더 뱃지 .62rem(~2996) → 최소 0.68rem. 레이아웃 넘침 생기면 컨테이너 쪽을 손보고 폰트는 낮추지 마라.

## 검증 (전부 통과해야 완료)
1. node --check static/game.js (+ main.py 를 건드렸으면 py_compile)
2. _test_exploration.py, _test_exploration_flow.py 회귀 통과.
   trpg conda 파이썬: `& "$env:USERPROFILE\anaconda3\envs\trpg\python.exe"`, PYTHONIOENCODING=utf-8
3. 서버 실동: GAME_PORT=8099 기동 → /health OK → 브라우저 없이도 index.html/정적 파일 응답 확인 →
   종료·잔류 프로세스 체크. CSS 는 정적 검토 + Codex 검증으로 갈음.
4. 구현 전 mcp__codex-bridge__ask_codex 로 계획 검토, 구현 후 검증.
5. 같은 문제 2회 실패 시 중단하고 "Fable 세션으로 가져가시라" 안내.
6. 마지막에 사용자 실기기 테스트 체크리스트(키보드 가림·버튼 크기·노치)를 3줄로 출력.
