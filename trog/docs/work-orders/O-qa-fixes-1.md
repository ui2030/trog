# [패키지 O] QA 수정 묶음 1 — 경험치 배분·동명 몬스터·장비 슬롯·탐색 접근성

사용자 실플레이 제보(2026-07-15) + Fable 조사 확정. 작업 폴더: `C:\Users\ui2030\Documents\trpg\trog`

공통 규칙:
- 시작 전 반드시 현재 코드를 먼저 읽어라. 아래 줄번호는 조사 시점 기준 — **grep으로 재확인**.
- 미커밋 변경(성능·모바일·탐색 오버레이·낙서판 L) 위에 얹어라 — 되돌리기 금지.
- 기존 스타일·태그 파서 관용구 준수. 대규모 리팩터링 금지. git 커밋 금지. IP 고유명사 금지.

## O-1. 어시스트 경험치 — 기여자 기록의 데이터 원천 신설 (main.py)

확정 원인: Monster.attackers(4015, note_attacker 4056)에 기록되는 유일한 지점이
_apply_hp_change(2190-2191)의 acting_player_id 1명뿐. 몬스터는 보통 한 턴 안에 죽으므로
attackers는 항상 1명 → _distribute_kill_xp(5150-5180)의 어시스트 분기가 영원히 공집합.
**_distribute_kill_xp만 고치면 안 된다 — 상류에 어시스트 데이터가 아예 없다.**

1. **기여 = 전투 중 행동**: player_action 처리에서 LLM 호출 전에, 살아있는 몬스터가 1마리라도
   있으면 살아있는 모든 몬스터에 `note_attacker(acting_player_id)`. 공격·치료·지원 불문 —
   협동 게임이므로 힐러도 어시스트를 받는 게 의도된 설계다(주석으로 명시).
2. **처치자 판정 교정**: note_attacker가 순서 보존 dedup이라 attackers[-1]이 더 이상
   "죽인 턴의 행동자"가 아니다. defeated 이벤트에 acting_player_id(그 턴 행동자)를 killer로
   싣고, _distribute_kill_xp는 그것을 우선 사용(없으면 attackers[-1] 폴백 — DOT 사망 등).
   어시스트 = attackers − killer. XP 수치·클램프(kill 20+max_hp//3 15~150, assist kill//3 5~50)는 불변.
3. 몬스터 정리 버튼(clear_monsters 7399-7419)은 **의도적으로 XP 없음 유지**(스폰-정리 파밍 방지,
   주석으로 명시).

## O-2. 동명 몬스터 개별 관리 (main.py)

확정 원인: 동명 스폰은 무시(2225-2230) → 고블린×3이 1마리로 붕괴. 또 _find(2167-2181)는
부분일치 후보가 2마리 이상이면 None → "고블린" HP 태그가 조용히 증발.

1. 동명 [적 등장] 두 번째부터 자동 접미사 부여: "고블린" → "고블린 B", "고블린 C"…(등록·브로드캐스트
   이름 모두). 로그 1줄.
2. _find 부분일치 다수 후보: **살아있는 것 중 가장 먼저 등장한 놈**을 선택 + warning 로그
   (조용한 증발보다 낫다 — 한계는 주석으로).
3. DM 프롬프트(arc_block 패턴)에 1줄: "같은 종류 적이 여럿이면 A/B/C로 구분해 명명하라."

## O-3. 장비 슬롯 오분류 (main.py + game.js)

확정 원인: ① 방어구 키워드에 **"옷"이 전 목록 부재** + 분류 실패 기본값이 main_hand(1786, 1819)
→ "낡은 옷" 착용 시 무기 칸 장착·무기 밀려남. ② 클라 수동장착 분류기(game.js 3414-3443,
1916-1923)가 구식 3슬롯·좁은 목록. ③ import(_apply_imported_sheet 4245-4270)가 "weapon" 키를
그대로 써 equipment_bonuses(3355)에서 보너스 증발.

1. `_NAME_SLOT_HINTS`(1794-1805) armor 정규식에 의류 계열 추가: 옷(단, "옷감" 제외 —
   부정 전방탐색 등)·튜닉·의복·갑주·경갑·중갑·조끼·코트. 공용 교정 함수라 자동장착·수동장착·
   대장간 전 경로 한 번에 해결.
2. **불확신 시 자동장착 금지**: 종류가 generic(장비 등)이고 이름 힌트도 없으면 main_hand로
   때려넣지 말고 **인벤토리 보관만**(사용자가 수동 장착). ITEM_KIND_KEYWORDS의 `장비→main_hand`(1786)
   기본값을 이 규칙으로 대체. 수동 장착 시엔 사용자가 슬롯 지정 가능하므로 기존 동작 유지.
3. 클라 분류기 2곳을 서버 `_NAME_SLOT_HINTS`와 동일 목록으로 미러링(4슬롯).
4. import 경로에 from_save_dict(3959-3971)와 동일한 weapon→main_hand 마이그레이션 추가.

## O-4. 탐색 접근성 (main.py + game.js)

1. **중단 권한 확장**: 탐색 시작자 id를 room 탐색 상태에 기록하고 시작 브로드캐스트에 동봉.
   중단 허용 = 방장 **또는 시작자**(서버 검사 + 클라 ⏹ 버튼 표시 조건 동일하게).
   현재 클라 `_abortExploration`의 `if (!isOwner) return`(game.js ~4568)과 서버 explore_abort
   핸들러 양쪽 수정.
2. **말로 탐색 시작**: `_is_explore_action(text)` 키워드 휴리스틱(_is_ambush_action 관용구):
   강한 의도만 — "탐색|수색|정찰" 포함, 또는 "(둘러|살펴)" + "(주변|근처|일대|지역)" 조합.
   "반지를 살펴본다" 같은 대상 관찰 오발 금지(간단히: 문장에 아이템 지칭 조사+살펴 조합은 통과시키지
   말 것 — 완벽 불가, 보수적 목록으로 시작하고 한계를 주석에). player_action 처리에서 감지 시
   **버튼 경로와 동일한 진입 함수** 재사용(중복 구현 금지). 진입 불가 상태(전투 중·이미 탐색 중 등
   기존 게이트)면 조용히 일반 LLM 경로로 폴백.

## 검증 (전부 통과해야 완료)
1. py_compile main.py / node --check static/game.js.
2. 신규 테스트: _test_kill_xp.py(전투 중 행동자 전원 기여 기록·killer=죽인 턴 행동자·어시스트 지급·
   한 턴 3킬 시 타 기여자 각각 어시스트·DOT 사망 폴백), _test_equipment.py(분류 매트릭스:
   옷/낡은 옷/튜닉/부츠/장갑/체인메일→armor, 장검/단검→main_hand, 방패→off_hand, 반지→accessory,
   generic 무힌트→미장착 인벤 보관, import weapon 키 마이그레이션), _test_monster_naming.py
   (동명 자동 접미사·다수 후보 _find 선택). 회귀: _test_balance, _test_exploration 계열, _test_act_progress.
   trpg conda 파이썬: `& "$env:USERPROFILE\anaconda3\envs\trpg\python.exe"`, PYTHONIOENCODING=utf-8.
3. 서버 실동(GAME_PORT=8099, _playtest_ws.py 패턴): 2인 방 → 전투 중 둘 다 행동 → 몬스터 처치 시
   양쪽 xp_events 수신(처치+어시) 확인. "주변을 수색한다" 텍스트로 탐색 시작 확인. 시작자(비방장)
   화면에 ⏹ 표시·중단 동작 확인 → 서버 종료, 잔류 프로세스 체크, 테스트 방 saves 삭제.
4. 구현 전 mcp__codex-bridge__ask_codex 계획 검토, 구현 후 검증.
5. 같은 문제 2회 실패 시 중단하고 상황 보고.
