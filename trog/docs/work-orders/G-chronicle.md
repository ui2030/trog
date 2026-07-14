# [패키지 G] 모험 연대기 — 캠페인이 끝나면 남는 기록

윤택화 로드맵(2026-07-14 Fable 설계) 2번. 작업 폴더: `C:\Users\ui2030\Documents\trpg\trog`

공통 규칙:
- 시작 전 반드시 현재 코드를 먼저 읽어라. 줄번호는 참고용 — **grep으로 재확인**.
- 다른 패키지(F, H~J)와 충돌 없이 병합. H(비밀 목표)가 이미 적용됐으면 그 결과도 연대기에 싣고, 없으면 해당 섹션 생략(의존 금지).
- 기존 스타일·태그 파서 관용구 준수. 대규모 리팩터링 금지. git 커밋 금지. IP 고유명사 금지.

설계 의도: 게임이 끝나도 남는 "우리 모험의 기념품" 한 장. 재플레이 동기의 뿌리.
LLM은 마지막 에필로그 문장만 쓰고, **사실 수집·MVP 산정은 전부 서버 데이터**로 한다.

## G-1. 사실 수집 — room.chronicle (main.py)

1. `GameRoom`에 `chronicle: List[dict] = []`, 상한 120(초과 시 오래된 것 트림 — 기존 캡 관용구).
   엔트리: `{"act": int, "kind": str, "who": str|None, "text": str}`. ts 불필요(순서로 충분).
2. 기록 훅(각 1~2줄, 기존 처리 지점에 삽입 — grep으로 정확한 위치 찾기):
   - 막 전환: E-2의 act_changed 판정 직후. kind="act", text="N막 돌입".
   - 사망: parse_and_apply_hp(2015)가 hp 0 도달을 아는 지점. kind="death".
   - 부활: 같은 함수의 revived 분기(D-3). kind="revive".
   - 몬스터 처치: 자동처치 XP 부여 경로(C-3). kind="kill", who=막타 플레이어, text에 몬스터명.
   - 탐색 하이라이트: _explore_trap_save의 완전회피(spot), _explore_encounter의 기습 성공(surprise)만.
     kind="feat". (flavor·골드·상점 구매는 노이즈 — 기록 금지.)
3. 플레이어별 누계 카운터: 이미 있는 값 재사용 우선(XP·레벨은 Player에 있음). 없는 것만
   Player에 추가: kills, heals_given(힐 태그로 남을 회복시킨 누계), traps_avoided.
   to_save_dict/from_save_dict 직렬화. chronicle도 저장 포함(서버 재시작 생존).

## G-2. 엔딩 감지 (main.py)

1. 현재 캠페인 "종료" 개념이 있는지 grep으로 확인(ending, finale, epilogue 등).
   있으면 그 지점 재사용, 없으면 신설:
   - DM 태그 `[엔딩]` — current_act가 3일 때만 유효. _parse_all_tags(4998)에 파서 추가.
     E-2의 교훈(중간 매치 오발 방지: 마지막 유효 매치만) 그대로 적용. 태그는 클라 렌더 전 strip.
   - DM 프롬프트의 arc_block(E-2)에 규약 1줄: "3막의 이야기가 완결되면 응답 끝에 [엔딩] 표기."
   - 폴백: 방장 전용 "📜 모험 마무리" 버튼(3막에서만 노출) → WS `finish_campaign` → 같은 종료 경로.
2. 종료 처리: `room.ended = True`(직렬화 포함), 이후 행동 입력은 막되 채팅은 허용.

## G-3. 에필로그 생성 + 연대기 페이지 (main.py + 클라)

1. 종료 시 LLM 1회 호출(기존 LLM 호출 헬퍼 재사용, 실패해도 연대기 자체는 떠야 함 — 에필로그만 생략):
   입력 = chronicle 요약 + 플레이어 시트(이름·직업·종족·레벨) + narrative_log 최근 30.
   출력 = 에필로그 3~5문단 + 플레이어별 한 줄 헌사. room.epilogue에 저장·직렬화.
2. MVP 칭호는 **서버 계산**(동률이면 둘 다): 최다 처치(kills), 파티의 방패(heals_given),
   신중한 자(traps_avoided). 0이면 해당 칭호 생략.
3. `GET /chronicle/{room_id}`: 서버 렌더 HTML 한 장(인라인 CSS, 모바일 반응형 간단히).
   내용: 시나리오명·톤(F 적용 시)·참가자 카드(초상화는 기존 /portrait/ URL 재사용)·
   막별 연대기 타임라인·MVP 칭호·에필로그·(H 적용 시) 비밀 목표 공개 섹션.
   room.ended가 아니면 404. 존재하지 않는 방도 404.
4. 클라: 종료 브로드캐스트 수신 시 전원에게 "📜 모험 연대기 보기" 버튼(새 탭 링크) 표시.

## 검증 (전부 통과해야 완료)
1. py_compile / node --check.
2. 신규 단위 테스트 _test_chronicle.py: 훅 기록·캡 트림·[엔딩] 오발 방지(1·2막에서 무시)·
   MVP 산정·save/load 왕복. 회귀: _test_balance, _test_exploration, _test_act_progress.
   trpg conda 파이썬, PYTHONIOENCODING=utf-8.
3. 서버 실동(GAME_PORT=8099): 방 생성→행동 몇 번→current_act를 테스트 훅으로 3 설정→
   finish_campaign→ /chronicle/{room_id} 200 + 초상화·타임라인 렌더 육안 확인 →
   서버 종료, 잔류 프로세스 체크, 테스트 방 saves 삭제.
4. 구현 전 mcp__codex-bridge__ask_codex 계획 검토, 구현 후 검증.
5. 같은 문제 2회 실패 시 중단하고 "Fable 세션으로 가져가시라" 안내.
