# [패키지 J] NPC가 기억함 — 이름 있는 NPC 호감도

윤택화 로드맵(2026-07-14 Fable 설계) 5번. 작업 폴더: `C:\Users\ui2030\Documents\trpg\trog`

공통 규칙:
- 시작 전 반드시 현재 코드를 먼저 읽어라. 줄번호는 참고용 — **grep으로 재확인**.
- 다른 패키지(F~I)와 충돌 없이 병합. G(연대기)가 있으면 "인연" 섹션 추가, 없으면 생략(의존 금지).
- 기존 스타일·태그 파서 관용구 준수. 대규모 리팩터링 금지. git 커밋 금지. IP 고유명사 금지.

설계 의도: 1막에서 도운 상인이 3막에서 알아보는 것. 클라 UI는 만들지 않는다 —
서버 기록 + DM 프롬프트 주입만으로 체감된다(최소주의).

## J-1. 서버: NPC 대장 (main.py)

1. `GameRoom.npcs: Dict[str, dict] = {}` — 키=NPC 이름(strip, 최대 12자).
   값 `{"disposition": int(-5..+5 클램프), "first_act": int, "last_act": int}`.
   상한 20 — 초과 시 last_act 가장 오래된 항목 제거. to_save_dict/from_save_dict 직렬화.
2. 태그 규약: `[NPC: 이름 +1]` / `[NPC: 이름 -1]` (±1만 유효, 다른 크기는 ±1로 클램프).
   _parse_all_tags(4998)에 파서 추가 — 기존 태그 파서 관용구(정규식·strip) 그대로.
   **응답당 NPC당 1회만 적용**(같은 NPC 다중 태그는 첫 매치만 — E-2의 오발 방지 교훈).
   없는 NPC면 신규 등록(first_act=현재 막). 태그는 클라 렌더 전 strip(기존 strip 경로).
3. DM 프롬프트 주입 2가지:
   - 규약 안내(정적): build_system_prompt(1630) 또는 arc_block(E-2) 패턴으로 1~2줄 —
     "이름 있는 NPC와 유의미한 상호작용이 있으면 [NPC: 이름 +1/-1]로 표기."
   - 현황(동적): per-request 조립 지점(파티 요약·note_parts 만드는 곳, ~5213 근처)에
     npcs가 비어있지 않으면 컴팩트 한 줄: "아는 NPC: 도린(호감+2, 2막부터), 그림자(호감-3, 1막부터)".
     이어서 가이드 1줄: "호감이 높으면 우호적으로, 낮으면 적대적으로 반응시켜라.
     단 골드·아이템·HP 수치는 기존 상한 규칙 그대로."
4. 호감도가 극단(+5/-5) 도달 시 chronicle(G 적용 시)에 kind="bond" 1회 기록.

## J-2. 최소 노출 (game.js — 선택적, 1시간 이내 분량만)

1. NPC 태그 파싱 결과를 브로드캐스트에 굳이 싣지 마라 — 신규 이벤트 타입 금지.
2. 유일한 노출: (G 적용 시) 연대기 페이지 "인연" 섹션 — 호감 상위/하위 NPC 각 2명,
   "도린은 파티를 잊지 않을 것이다(호감 +4)" 식 서버 템플릿 문장. LLM 호출 없음.

## 검증 (전부 통과해야 완료)
1. py_compile / node --check(수정했다면).
2. 신규 _test_npc_memory.py: 태그 파싱(±1 클램프·다중 태그 1회 적용·이름 12자 컷)·
   disposition 클램프·상한 20 LRU·save/load 왕복·태그 strip 확인.
   회귀: _test_balance, _test_exploration, _test_act_progress.
   trpg conda 파이썬, PYTHONIOENCODING=utf-8.
3. 서버 실동(GAME_PORT=8099): 행동 몇 번 → DM 응답에 NPC 태그가 나오면 room.npcs 반영 확인
   (안 나오면 messages에 태그 포함 응답을 주입하는 테스트 훅으로 확인) →
   종료, 잔류 프로세스 체크, 테스트 saves 삭제.
4. 구현 전 mcp__codex-bridge__ask_codex 계획 검토, 구현 후 검증.
5. 같은 문제 2회 실패 시 중단하고 "Fable 세션으로 가져가시라" 안내.
