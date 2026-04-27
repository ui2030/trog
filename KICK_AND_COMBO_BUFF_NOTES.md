# 🚪 강퇴 → dormant + ⚔ 장비 조합 영구 버프 (2026-04-28)

## 1. 강퇴 시 캐릭터 보존 (휴면)

### 문제
방장이 플레이어 강퇴(`kick_player`) 시 `room.players.pop(target_id)` 으로 **완전히 삭제** → 인벤·레벨·장비·골드 전부 소실. 복구 불가능. 큰 결함.

### 해결
- `kick_player` 핸들러를 `_move_to_dormant` 사용으로 전환 — `leave_room` 과 동일한 dormant 경로
- 인벤·레벨·장비·골드·status_effects 모두 보존
- 강퇴된 본인은 알림 + close, 2분 뒤 다른 사람이 takeover 가능 또는 본인이 재접속 가능
- 방장이 자기 자신 강퇴는 여전히 막혀있음 (방어적으로 `target_was_owner` 체크 추가 — 이론상 unreachable 이지만 owner_transfer 로직 일관성 유지)
- `player_left` 브로드캐스트에 `went_dormant: true` + `dormant: _dormant_summary(room)` 동봉 → 클라가 휴면 섹션 갱신

### Owner 즉시 전환
`leave_room` 핸들러 — 이미 즉시 전환 (`_transfer_owner_or_vacate(room, player_id)`) 되고 있었음.
- 게임 중 (`room.started`): dormant 이동 → 후계자 자동 지정
- 대기실: 완전 삭제 → 후계자 자동 지정
- `_pick_new_owner` 가 연결된 후보 중 한 명 선택, 없으면 `owner_id=None` 후 다음 입장자가 `_claim_vacant_owner` 로 승계

---

## 2. ⚔ 장비 조합 영구 버프

### 컨셉
특정 장비 조합이 갖춰지면 자동으로 영구 버프(infinite turns) 가 발동. 일반 status_effects 와 별도 시스템 — 턴 감소 X.

### 구현
- `Player.combo_buffs()` — 현재 4슬롯 상태를 검사해 조건 매칭되는 버프 dict 리스트 반환
- `Player.combo_buff_bonuses()` — 버프 effect 텍스트 파싱해 stat 보너스로 변환
- `equipment_bonuses()` 가 combo_buff 보너스도 합산 → effective stat 자동 적용
- `to_dict` 에 `combo_buffs` 필드 추가

### 정의된 조합 7종

| ID | 조건 | 이름 | 효과 |
|---|---|---|---|
| `dual_wield` | main_hand == off_hand (양손 동일) | 쌍수 (Dual-Wield) ⚔ | 2회 공격, 치명타 +10%, 공격 +3 |
| `sword_and_shield` | 검·도·도끼·철퇴 + 방패 | 검과 방패 🛡 | 균형 자세 — 방어 +3, CON +1 |
| `two_handed` | 대검·양손·클레이모어·할버드 (off_hand 비움) | 양손 무기 💪 | 강타 — 공격 +5, STR +1, 속도 -1 |
| `ranged` | 활·석궁·장궁 (off_hand 비움) | 원거리 사격 🏹 | 정밀 — 공격 +2, DEX +1 |
| `staff_and_grimoire` | 지팡이·완드·오브 + 마법서·그리모어 | 지팡이와 마법서 🔮 | 마법 집중 — INT +2, 마력 최대 +10 |
| `holy_warrior` | 철퇴·메이스 + 성표·십자가 | 성스러운 전사 ✨ | 신성 가호 — WIS +2, 방어 +2 |
| `full_plate` | 갑옷·판금 + 방패 | 풀 갑주 🛡 | 철벽 — 방어 +3, CON +1, 속도 -1 |

### UI 표시
- char-panel + party-panel 의 status-row 에 일반 버프/디버프와 함께 칩으로 표시
- `combo-buff` 클래스 — 시안색 톤 + ∞ 턴 표시 + 그림자 효과로 영구 버프임을 시각적 구분
- tooltip 에 "(영구 — 장비 조합)" + 효과 상세

### 적용 동선
1. 플레이어가 단검 두 자루 장착 → 양손에 단검
2. 서버: `combo_buffs()` 가 dual_wield 매치 → "공격 +3" 보너스 → `equipment_bonuses()` 에 합산
3. 클라이언트 char-panel 의 공격 행: `15 + 3 (dual) = 18 🛡+3`
4. 상태 칩 영역에 `⚔ 쌍수 ∞` 표시

---

## 비판적 셀프 리뷰

### 🟢 호환성
- combo_buffs 는 read-only 계산 — 데이터 저장 안 됨. 장비 바뀌면 자동 재계산.
- 구버전 save 무관 — equipped 슬롯만 있으면 자동 적용.
- equipment_bonuses 가 자동으로 combo 합산 → 기존 effective_stat 흐름 그대로 사용.

### 🟡 한계 — 조합 우선순위
- `dual_wield` 와 `sword_and_shield` 가 동시 매치되는 경우는 없음 (mh==oh vs mh+shield 상호 배타) — `elif` 구조로 처리
- 단 `full_plate`(갑옷+방패) 와 `sword_and_shield`(검+방패) 는 둘 다 매치 가능 → 둘 다 적용 (의도)
- 방어 보너스 중첩: 검+방패 +3 + 풀갑주 +3 = +6. 좀 셀 수 있음 — 추후 밸런스 조정 가능

### 🟡 한계 — 키워드 매칭 모호성
- "거대한 양손도끼" → mh 에만, off_hand 비움 시 `two_handed` 매치
- 그런데 `대검|양손|클레이모어` 정규식 — "양손도끼" 의 "양손" 매치됨. OK.
- "성검" 같은 모호한 이름은 일반 검으로 매치되어 `sword_and_shield` 로 들어감 (방패 들었을 때)

### 🟡 한계 — 음수 보너스 ("속도 -1")
- 현재 정규식 `_STAT_BONUS_PATTERNS` 는 +N 만 처리
- 조합 effect 의 음수는 별도 정규식 `r"속도\s*\-(\d+)"` 만 잡음 → DEX 감소
- 다른 음수 (예: "방어 -2") 는 미처리. 현재 정의된 7종 콤보엔 음수가 "속도 -1" 만 있어 OK.

### 🟢 강퇴 → dormant
- `_move_to_dormant` 가 이미 검증된 함수 (leave_room 등에서 사용 중) 라 안전
- target_ws.close() 후 finally 에서 본인 슬롯 체크 통과 — race 없음
- save_room 으로 디스크에 dormant 상태 영속화

---

## 검증 체크리스트

- [ ] 방장이 다른 플레이어 강퇴 → 플레이어 카드 사라지지만 휴면 섹션에 나타남
- [ ] 강퇴된 본인은 alert 로 메시지 + 화면이 entry 로 복귀
- [ ] 강퇴 후 2분 뒤 다른 사람이 같은 방 입장 시도 → takeover 모달에 그 캐릭터 등장
- [ ] takeover 하면 인벤·레벨·장비 그대로 복원
- [ ] 도적 캐릭터 → 양손 단검 → ⚔ 쌍수 칩 표시 + 공격 +3 적용
- [ ] 전사가 강철검 + 강철 방패 → 🛡 검과 방패 칩 + 방어 +3 + CON +1
- [ ] 양손 무기 ("거대한 양손도끼") + off_hand 비움 → 💪 양손 무기 칩 + 공격 +5 + STR +1 + DEX -1
- [ ] 마법사가 지팡이 + 마법서 → 🔮 마법 집중 칩 + INT +2 + max_mp +10
- [ ] 장비 빼면 칩과 보너스 모두 자동 사라짐

---

## 변경 파일
- `trog/main.py` — kick_player 핸들러 dormant 전환, `Player.combo_buffs()`/`combo_buff_bonuses()` 신규, `equipment_bonuses` 가 combo 합산, `to_dict` 에 `combo_buffs` 노출
- `trog/static/game.js` — `renderStatusChips(statuses, comboBuffs)` 시그니처 확장, party/char panel 호출처 갱신
- `trog/static/style.css` — `.status-chip.combo-buff` 시안색 영구 버프 스타일
