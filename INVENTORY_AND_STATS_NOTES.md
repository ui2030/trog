# 🎒 인벤토리 정렬 + 접기 + 🛡 장비 능력치 적용 (2026-04-28)

## 변경 내용

### 1. 인벤토리 종류별 그룹화 + 접기/펼치기
이전: 모든 아이템이 일렬로 섞여서 표시 (장비·소모품·퀘스트 혼재).
지금: 3개 그룹으로 분리 — **🛡 장비 / 🍶 소모품 / 📜 퀘스트** 순. 각 그룹 헤더 클릭으로 접기·펼치기.

- [game.js refreshCharPanel](trog/static/game.js) 인벤토리 렌더링 로직 재작성:
  - `groups = { equipment: [], consumable: [], quest: [] }` 으로 분류
  - 각 그룹 내부는 이름순 (한국어 collation) 정렬
  - 그룹 헤더에 chev (`▶`/`▼`) + 항목 개수 표시
  - 비어있는 그룹은 표시 안 함
- 클릭 토글 → `localStorage['trog-inv-collapsed']` 에 저장 → 다음 세션에도 유지
- CSS `.inv-group` `.inv-group-header` `.inv-group-body` 추가 — `max-height` transition 으로 부드러운 접기

### 2. 🛡 장비 효과 → 능력치 자동 합산

**문제**: 장비 효과 텍스트("공격 +5", "기교 (DEX) +2") 가 char-panel 에 보이지만 실제 `attack`/`dexterity` 등 수치는 안 늘어나서, 장비 입었는데 "데미지 같은데?" 모순.

**해결**:
- `Player.equipment_bonuses()` 메서드 신설 — 장착된 모든 슬롯의 effect 텍스트를 정규식으로 파싱해서 `{stat: bonus}` dict 반환
- 매핑 정규식 (한↔영 alias):
  - `공격 +N` / `방어 +N` / `HP/MP 최대 +N`
  - `STR/근력 +N` / `INT/지능 +N` / `WIS/지혜 +N` / `DEX/기교/민첩 +N` / `CHA/매력 +N` / `CON/건강 +N`
- 양손 동일 무기(쌍단검) 보너스 **중복 적용 방지** — main_hand 와 off_hand 가 같은 이름이면 한 번만 카운트
- `to_dict` 에 `equipment_bonuses` 필드 추가 → 클라가 받음
- `_players_summary` (DM 향) 도 effective 표시: `공격: 20(기본 15+5)` 형식 → DM 이 강해진 캐릭터를 인지하고 서사·판정에 반영

**클라이언트 표시**:
- `renderStatWithEquip(base, buffDelta, equipBonus)` 신설 — 합산값 표시 + 🛡+5 배지 (tooltip "기본 N + 장비 +M")
- 공격/방어/6 능력치 모두 새 헬퍼 사용
- abilityRow 의 modifier 도 effective 기준으로 재계산

**무시되는 효과**:
- `%` 가 붙은 보너스 (예: "치명타 확률 +10%") — 기계적 적용 어려워 DM 서사로만
- 조건부 효과 ("출혈 부여", "은신 시 +25%") — 마찬가지로 DM 재량

---

## 비판적 셀프 리뷰

### 🟢 안전
- equipment_bonuses 는 read-only — base stat 은 그대로 유지. 장비 빼면 자동으로 보너스 사라짐.
- 정규식 매치 실패해도 silent skip → 잘못된 effect 텍스트로 크래시 없음.

### 🟡 한계 — `%` 보너스 미적용
- "회피 +10%" 같은 효과는 텍스트로만 보일 뿐 수치 변동 없음.
- 향후 별도 `pct_bonuses` dict 만들고 판정 시점에 적용 가능하지만 복잡도 ↑.
- 현재는 DM 이 서사로 반영 (예: "민첩한 부츠 덕에 화살이 빗나갔다") 가정.

### 🟡 한계 — 효과 텍스트 다양성
- 자유 텍스트라 LLM 이 "STR을 1 올린다" 같이 +N 포맷 안 쓰면 매치 실패.
- DM 프롬프트에 "공격 +5 / 방어 +3 식으로 쓰라"고 이미 적혀있어 대부분 잡힘.
- 매치 실패 케이스: "강력한 검", "민첩성을 강화" — 추상 표현. 적용 안 됨. 합당.

### 🟡 한계 — 인벤 그룹화의 동기화
- `localStorage` 가 브라우저별 저장 → 모바일↔데스크탑 동기화 안 됨.
- 새로고침 후 첫 렌더에 한해 깜빡임 가능 (script 로드 후 dom 갱신).

### 🟢 호환성
- 인벤토리 데이터 구조 자체는 그대로 (`{name, effect, quantity, kind}`). 분류만 클라에서.
- 구버전에서 kind 빠진 항목은 자동으로 'consumable' 그룹.

---

## 검증 체크리스트

- [ ] 캐릭터 패널 → 소지품 섹션이 🛡장비 / 🍶소모품 / 📜퀘스트 3그룹으로 분리됨
- [ ] 그룹 헤더 클릭 → 접힘/펼침. 새로고침해도 상태 유지
- [ ] "강철검 (공격 +5)" 장착 → 공격 스탯에 `🛡+5` 배지 + 합산값 표시
- [ ] "기교 (DEX) +2" 효과 장신구 → DEX 행에 합산 + modifier 도 +1 보정
- [ ] "치명타 +10%" 같은 % 효과는 표시 안 됨 (DM 서사로만 반영)
- [ ] 장비 해제하면 보너스도 자동 사라짐
- [ ] 쌍단검(양손 동일) 효과 보너스 1번만 적용 (중복 X)

---

## 변경 파일
- `trog/main.py` — `Player.equipment_bonuses()` / `effective_stat()` 신규, `_STAT_BONUS_PATTERNS` 정규식, `to_dict`에 `equipment_bonuses` 필드, `_players_summary` effective 표시
- `trog/static/game.js` — 인벤 그룹화·정렬·접기 로직, `eqBonuses` 변수, `renderStatWithEquip` 헬퍼, abilityRow effective 적용
- `trog/static/style.css` — `.inv-group*` 스타일, `.stat-equip-bonus` 배지
