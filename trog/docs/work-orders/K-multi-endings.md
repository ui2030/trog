# [패키지 K] 다중 엔딩 + 엔딩 도감 — 결말의 판정권을 서버로

윤택화 로드맵(2026-07-14 Fable 설계) 최종장 = 구 후보 2 확정안. 작업 폴더: `C:\Users\ui2030\Documents\trpg\trog`

**선행 조건: G(연대기) 적용 후에만 착수.** J(NPC 호감) 강권 — 없으면 호감 축은 중립 처리(아래 K-1.4).
H(비밀 목표)는 선택 — 있으면 개인 에필로그에 반영.

공통 규칙:
- 시작 전 반드시 현재 코드를 먼저 읽어라. 줄번호는 참고용 — **grep으로 재확인**.
- 기존 스타일·태그 파서 관용구 준수. 대규모 리팩터링 금지. git 커밋 금지. IP 고유명사 금지.

설계 원리: 기존 철학 그대로 — **엔딩 판정은 서버가 숫자로 확정, LLM은 그 결말을 서술만.**
"전부 해피 수렴"의 근본 원인(LLM 재량)을 판정권 회수로 제거한다.

## K-1. 판정 — decide_ending (main.py)

1. `ENDINGS` 모듈 상수 — 순서가 곧 판정 우선순위(첫 매치). 각 {id, emoji, label, hint, brief}:
   | id | emoji | label | hint(도감 잠금 시) | brief(LLM 기조 2줄 요약) |
   |----|-------|-------|--------------------|--------------------------|
   | fallen | 💀 | 몰락 | 모두가 쓰러지면… | 파티 전멸의 비극. 남겨진 세계가 그들을 기억하는 방식으로 끝내라. |
   | legend | 🌟 | 전설이 되다 | 아무도 잃지 않고, 사람들의 마음도 얻는다면… | 완벽한 승리. 노래와 전설로 남는 영웅담으로 끝내라. |
   | feared | 🖤 | 공포로 기억되다 | 목적을 위해 모두를 적으로 돌린다면… | 이겼으나 세상이 그들을 두려워한다. 차갑고 불길한 여운. |
   | scars | 🩸 | 영광의 상처 | 많은 것을 잃고도 끝까지 나아간다면… | 승리했지만 잃은 동료의 그림자가 짙다. 씁쓸하고 숙연하게. |
   | gilded | 💰 | 황금 용병단 | 명예보다 금화를 택한다면… | 부자가 되었지만 마음을 얻지 못했다. 풍자적이고 건조하게. |
   | beloved | 🕊 | 민중의 벗 | 검보다 마음을 나눈다면… | 사람들의 사랑을 받는 영웅들. 따뜻한 축제 분위기로. |
   | unsung | ⚔ | 이름 없는 영웅들 | 그저 묵묵히 할 일을 한다면… | 화려하지 않지만 단단한 마무리. 담백하게. |
2. 판정 재료 — 서버 카운터만 사용(전부 이미 존재하거나 G가 추가):
   - `deaths_total`: 캠페인 누적 사망 횟수. G-1 훅에서 세는 값이 chronicle 기록뿐이면
     room 카운터로 승격해 직렬화(chronicle은 캡 120이라 집계용으로 부적합).
   - 호감: room.npcs(J)에서 friends = disposition ≥ +3 수, enemies = ≤ -3 수.
   - 골드: 파티 소지금 합.
   - 전멸: 전멸 상태가 코드에 존재하는지 grep(전원 hp 0 등). **존재할 때만** fallen 분기 구현,
     없으면 fallen은 ENDINGS에서 빼고 6종 운영(주석으로 사유).
3. 튜닝 레버(모듈 상단 상수): `END_DEATHS_HEAVY = max(2, 인원수)` 산식,
   `END_GOLD_RICH = 2000`, friends/enemies 문턱(+3/-3)도 상수.
4. `decide_ending(room) -> {"id", "label", "emoji", "reasons": [str]}` — **순수 함수**로 분리(테스트 용이).
   우선순위: fallen → legend(사망0 ∧ friends≥2 ∧ friends>enemies) → feared(enemies>friends)
   → scars(deaths_total ≥ HEAVY) → gilded(골드≥RICH ∧ friends<2) → beloved(friends≥2) → unsung.
   reasons는 사람이 읽는 근거 문자열: "파티 사망 0회", "NPC 친구 2명(이름들)", "최종 소지금 2,340G".
   **J 미적용/미기록 시** friends=enemies=0으로 자연 강등(legend·feared·beloved 불가) — 별도 분기 금지.

## K-2. 결말 유도 — 3막 잠정 판정 주입 (main.py)

1. current_act == 3이고 room.ended가 아니면, per-request 프롬프트 조립(J-1.3과 같은 지점)에 1줄:
   "[결말 기조] 지금까지의 여정은 '{label}' 쪽으로 흐르고 있다({reasons 요약}).
   이야기를 결말로 이끌 때 이 기조를 따르고, 완결되면 [엔딩]을 표기하라."
   — decide_ending은 순수 함수라 매 요청 계산해도 싸다. 1·2막에서는 주입 금지(스포일러 방지).
2. G-2의 종료 처리 시점에 최종 판정 확정 → `room.ending = decide_ending(room)` 직렬화.
   G-3 에필로그 LLM 호출 입력에 ending의 label+brief+reasons를 추가해 결말 기조를 강제.

## K-3. 엔딩 도감 — 서버 전역 수집 (main.py + 클라)

1. `saves/_endings_seen.json` 전역 파일: {ending_id: {"count": int, "first_at": iso날짜}}.
   종료 확정 시 갱신 — 기존 save 쓰기 관용구(원자적 쓰기/to_thread)를 그대로 재사용.
   파일 없음/파손 시 빈 도감으로 폴백(기동 실패 금지).
2. 연대기 페이지(G-3)에 엔딩 카드 최상단 배치: emoji+label+reasons.
   그 아래 도감 섹션: 7칸 — 본 엔딩은 emoji+label+횟수, 못 본 엔딩은 "???" + hint.
3. 로비 노출: `/scenarios` 응답(F-2에서 tones 동봉한 것과 같은 방식)에
   `endings_seen: {seen: n, total: m}` 동봉 → 로비 한 줄 "📖 본 엔딩 {n}/{m}".
   n≥1일 때만 표시(첫 판 스포일러 방지).

## K-4. 스코프 밖 (만들지 마라)
- 계정·크로스캠페인 플레이어 성장(메타 진행) — 계정 인프라 없음, 의도적 배제.
- 선택지 트리 저작 — LLM 즉흥 서사는 그대로 둔다. 판정권만 서버가 쥔다.
- 엔딩별 별도 시나리오 분기 콘텐츠 — brief 2줄 기조 주입으로 충분.

## 검증 (전부 통과해야 완료)
1. py_compile / node --check.
2. 신규 _test_endings.py: decide_ending 우선순위 매트릭스(7종 각각 도달하는 입력 1개씩 +
   경계값: 사망 HEAVY-1/HEAVY, friends 1/2), J 부재 시 강등 동작, reasons 문자열 생성,
   도감 파일 갱신·파손 폴백. 회귀: _test_balance, _test_exploration, _test_act_progress,
   _test_chronicle(G). trpg conda 파이썬, PYTHONIOENCODING=utf-8.
3. 서버 실동(GAME_PORT=8099): 테스트 훅으로 3막 진입 → [결말 기조] 주입이 프롬프트에 포함되는지 확인
   → finish_campaign → /chronicle에 엔딩 카드+도감 렌더, _endings_seen.json 갱신 육안 확인
   → 서버 종료, 잔류 프로세스 체크, 테스트 방 saves 삭제(_endings_seen.json의 테스트 기록도 원복).
4. 구현 전 mcp__codex-bridge__ask_codex 계획 검토, 구현 후 검증.
5. 같은 문제 2회 실패 시 중단하고 "Fable 세션으로 가져가시라" 안내.
