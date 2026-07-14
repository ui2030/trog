# [패키지 H] 개인 비밀 목표 — 각자에게만 주어지는 미션

윤택화 로드맵(2026-07-14 Fable 설계) 3번. 작업 폴더: `C:\Users\ui2030\Documents\trpg\trog`

공통 규칙:
- 시작 전 반드시 현재 코드를 먼저 읽어라. 줄번호는 참고용 — **grep으로 재확인**.
- 다른 패키지(F·G·I·J)와 충돌 없이 병합. G(연대기)가 있으면 결과 공개를 연대기에 싣고, 없으면 엔딩 토스트 폴백(의존 금지).
- 기존 스타일 준수. 대규모 리팩터링 금지. git 커밋 금지. IP 고유명사 금지.

설계 원칙 (감사 C의 철학 연장): **판정은 전부 서버 데이터로 자동 감지**한다.
LLM(DM)은 비밀 목표의 존재를 모른다 — **DM 프롬프트에 절대 넣지 않는다**(공유 프롬프트라 새어나감).

## H-1. 목표 풀 + 배정 (main.py)

1. `SECRET_GOALS` 모듈 상수 12종. `{id, label, desc, kind, target}`. 확정 목록:
   - potion_3: "물약 애호가" — 물약 3회 사용 (try_use_potion 성공 경로, 1930)
   - shop_3: "단골 손님" — 상점 구매 3회 (try_shop_buy 성공 경로, 1915)
   - gold_500: "한몫 잡기" — 소지금 500 도달 (골드 갱신 경로, C-1 클램프 지점)
   - heal_50: "파티의 은인" — 힐로 동료 회복 누계 50 (parse_and_apply_hp, 본인 제외 대상)
   - trap_2: "돌다리도 두들겨" — 함정 완전회피/경감 2회 (_explore_trap_save)
   - surprise_2: "그림자 걸음" — 조우 기습 성공 2회 (_explore_encounter surprise)
   - discover_2: "보물 사냥꾼" — 탐색 발견 2회 (discovery 경로)
   - kill_3: "결정타" — 몬스터 막타 3회 (C-3 자동처치 어트리뷰션)
   - chat_10: "분위기 메이커" — 채팅 10회 (채팅 처리 ~6650 근처)
   - levelup_2: "성장통" — 레벨업 2회 (레벨업 경로)
   - no_death: "무사 귀환" — 사망 0으로 완주 (엔딩 시 판정 — G의 종료 지점. G 미적용이면 이 목표는 풀에서 제외하고 11종 운영, 주석으로 사유)
   - item_5: "수집가" — 아이템 획득 누계 5 (C-4 아이템 파서)
   전 직업·전 종족이 달성 가능해야 함(직업 특화 조건 금지).
2. 배정: 모험 시작 지점(start_adventure 계열 — grep)에서 인원수만큼 **중복 없이** 랜덤 배정.
   난입/복귀 플레이어는 입장 시점에 미배정이면 그때 배정(남은 풀에서).
   `Player.secret_goal = {"id", "progress": 0, "done": False, "done_act": None}` — 직렬화 포함.
3. 진행 헬퍼 하나: `def bump_secret_goal(room, player, kind, amount=1)` — 해당 kind가 아니면 즉시 return,
   done이면 return, progress 증가, target 도달 시 done=True + done_act 기록 + **본인에게만** send_json
   `{"type": "secret_goal_done", ...}` + (G 적용 시) chronicle에 kind="secret" 기록.
   gold_500 같은 "도달형"은 amount 대신 현재값 비교. 각 이벤트 지점에 호출 1줄씩.
   **브로드캐스트 금지** — E-2 때 직접 send_json 주입 지점을 다룬 경험 참고, 반드시 개인 소켓만.

## H-2. 클라 (game.js + index.html + style.css)

1. 배정 수신 `{"type": "secret_goal", label, desc, progress, target}`: char-panel에
   "🤫 비밀 목표" 접이식 섹션(기존 상점 접이식 패턴 재사용), 진행도 "1/3" 표시.
   rejoin_ok 계열에도 현재 상태 동봉해 복구.
2. 달성 수신: 본인에게만 금색 토스트 "🤫 비밀 목표 달성 — {label}!" (기존 sysToast/토스트 레이어 재사용,
   reduced-motion 존중). 섹션 표시를 ✅로.
3. 엔딩 시 공개: G 있으면 연대기 페이지 섹션(누가 뭘 받았고 달성/실패). G 없으면
   종료 브로드캐스트에 전원 결과 요약을 실어 토스트로 폴백.

## 검증 (전부 통과해야 완료)
1. py_compile / node --check.
2. 신규 _test_secret_goals.py: 중복 없는 배정·bump 진행/완료·도달형(gold)·done 이후 불변·
   save/load 왕복. 회귀: _test_balance, _test_exploration, _test_act_progress.
   trpg conda 파이썬, PYTHONIOENCODING=utf-8.
3. 서버 실동(GAME_PORT=8099, _playtest_ws.py 패턴): 2인 방 → 각자 다른 목표 수신 확인 →
   물약 3회 사용 시나리오로 달성 이벤트가 **본인에게만** 오는 것 확인(상대 소켓 수신 없음 assert)
   → 종료, 잔류 프로세스 체크, 테스트 saves 삭제.
4. 구현 전 mcp__codex-bridge__ask_codex 계획 검토, 구현 후 검증.
5. 같은 문제 2회 실패 시 중단하고 "Fable 세션으로 가져가시라" 안내.
