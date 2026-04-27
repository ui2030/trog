# 🔧 시스템 감사 — 발견 결함 + 적용한 수정 (2026-04-28)

## 감사 범위
- **백엔드** (`trog/main.py`, ~5000줄) — 동시성, WS 생명주기, LLM 출력 검증, 데이터 무결성
- **프론트엔드** (`trog/static/game.js`, ~3340줄) — 메모리 누수, 핸들러 race, XSS, 재연결 안정성

서브에이전트 두 개로 병렬 감사 후 우선순위 높은 결함부터 수정.

---

## 🔴 적용한 critical 수정 (5개)

### 1. WS 중복 연결 race — 멀쩡한 세션 끊김
[main.py:_assign_player_connection 신규](trog/main.py)

**문제**: 같은 `player_id`로 두 번째 WebSocket이 들어오면 `connections[pid] = ws`로 silently 덮어씀. 옛 WS 의 `finally` 블록이 *현재 활성* connection 을 pop → 멀쩡한 세션이 끊김. 두 탭, 재로그인, 악의적 클라이언트가 다른 사람 세션 강제 종료 가능했음.

**수정**:
- 새 helper `_assign_player_connection(room, pid, ws)` — 기존 WS 가 있으면 `session_replaced` 알림 후 close, 그 다음 새 WS 할당
- 4곳의 `connections[pid] = ws` → 모두 `await _assign_player_connection(...)` 로 교체
- finally 블록: `room.connections.get(pid) is websocket` 체크 후에만 pop. 다른 슬롯이면 `return` 으로 cleanup 스킵 (활성 세션 보호)

### 2. 프론트엔드 WS 좀비 핸들러
[game.js:connect, scheduleReconnect](trog/static/game.js)

**문제**: 재연결 시 옛 ws 의 `onmessage`/`onclose` 가 명시적으로 null 처리 안 됨. close() 가 비동기라 옛 ws 의 늦은 메시지가 신 ws 와 동시에 `handle()` 호출 가능. 또한 onclose 가 또 `scheduleReconnect()` 를 호출해 옛/신이 둘 다 재연결 타이머 등록 시도.

**수정**:
- `_detachWsHandlers(oldWs)` — 새 ws 만들기 전 항상 호출, 옛 핸들러 4개 모두 null
- 새 ws 대입 직전에 `_detachWsHandlers(ws)` 호출

### 3. 무한 재연결 루프 → 지수 백오프
[game.js:scheduleReconnect](trog/static/game.js)

**문제**: 서버 영구 다운이면 3초마다 영원히 재시도 → 모바일 배터리 낭비, 서버 재기동 시 thundering herd.

**수정**: 지수 백오프 3s → 6s → 12s → 24s → 48s → 60s(cap). `onopen` 성공 시 `_reconnectAttempts = 0` 리셋.

### 4. Cooldown race — spam 차단 우회 가능
[main.py:linger_action / player_action 핸들러](trog/main.py)

**문제**: `last_action_at[pid]` 가 `process_action` 내부 `room.lock` 획득 후에야 갱신. 클라가 LLM 응답 전(5~10초) 5번 연타하면 모두 cooldown 검사 통과 (첫 갱신 전 모두 비교) → 5개가 lock 큐에 쌓여 모두 LLM 호출 → 토큰 폭탄.

**수정**: 검사 통과 직후 `room.last_action_at[pid] = time.time()` 갱신. lock 획득과 무관하게 spam 차단.

### 5. XSS 방어 — `p.name` 무이스케이프 alt 속성
[game.js:refreshPlayers, refreshCharPanel](trog/static/game.js)

**문제**: `<img alt="${p.name}">` 같이 attribute 안에 plaintext 보간. `p.name = '"><script>'` 같은 입력 시 attribute escape 가능. 서버 sanitization 약하면 XSS.

**수정**: 모든 `p.name`/`p.portrait_url`/`p.emoji`/`p.race_emoji`/`raceLabel(p)`/`p.character_class` 인터폴레이션을 `escapeHtml()` 로 감쌈. 3곳 (party-panel compact, party-panel expanded, char-panel).

---

## 🟠 적용한 mid-priority 수정 (3개)

### 6. Monster spawn HP 무제한
[main.py:parse_and_apply_monsters](trog/main.py)

**문제**: `int(m.group(2))` 만 — 9999999999 같은 극단값 그대로 통과. `Monster.__init__` 내부 `max(1, ...)` 가드 있지만 상한은 없음.

**수정**:
- HP 범위 `max(1, min(1000, hp))` — D&D 5e 기준 최강 보스 ~600 HP, 1000 cap 충분
- 이름 길이 ≤ 40자 검증 (UI 파괴 방지)
- 같은 이름 재spawn 시 silent ignore 대신 디버그 로그

### 7. Monster 이름 desync — 부분 매칭 폴백
[main.py:parse_and_apply_monsters._find](trog/main.py)

**문제**: spawn 태그는 `[적 등장: 고블린 궁수]`, HP 태그는 `[적 HP: 고블린 ...]` 로 어긋날 때 silent miss → 적이 무한 살아있는 desync.

**수정**: 1차 정확 매칭 → 실패 시 부분 매칭(한쪽이 다른쪽 포함). 후보 정확히 1개일 때만 채택. 다중 후보면 안전하게 무시.

### 8. Player.from_save_dict — raw 대입 → 검증·clamp
[main.py:Player.from_save_dict](trog/main.py)

**문제**: `p.hp = d["hp"]` 등 raw 대입. 손상된 save (음수, 문자열, 9e99) 가 객체 깨뜨려 후속 broadcast 직렬화 실패까지 갈 수 있음.

**수정**: `_clamp_int(key, lo, hi, default)` 헬퍼로 모든 수치 필드 (hp/max_hp/mp/max_mp/attack/defense/level/xp) 안전 변환. 잘못된 값은 default 폴백, 합리적 상한 (max_hp ≤ 99999, level ≤ 99, xp ≤ 9_999_999).

---

## 🟡 미적용 — 우선순위 낮음 (참고)

발견했으나 임팩트 낮아 이번엔 미적용. 차후 후보:
- **Document-level click 핸들러 영구 누적** (`game.js:3326`) — dice expand 핸들러. 1개라 성능 영향 미미.
- **typewriter 동시 실행** (`game.js:typewrite`) — dead code (`dmMsg` 가 호출 안 함). 사용 시 race 위험.
- **dormant grace 중 owner 부재 UX** — owner 자동 전환은 grace 만료 후. 그 사이 방장 권한 액션 막힘. 즉시 전환 vs 복귀 시 권한 회수 trade-off 결정 필요.
- **toast setTimeout 중첩** — `pushToast` 외부 SetTimeout 안 또 inner SetTimeout. 노드 GC 시 죽은 타이머 부유. 무해.
- **stat-plus confirm 타이머 부유** (`game.js:1856/1896`) — dataset.timeoutId 추적되지만 재렌더 시 dataset 통째 사라져 clearTimeout 불가. 재현 빈도 낮음.

---

## 비판적 셀프 리뷰 — 이번 수정의 위험

### 🟡 `_assign_player_connection` 의 race 가능성
- `room.connections.get(pid) is websocket` 비교는 동시성 안전한가? Python dict 단일 lookup 은 GIL 보호로 atomic. OK.
- 그러나 close 가 비동기 — close 호출 후 finally 가 트리거되기 전 새 ws 가 슬롯 잡으면 정상. 만약 close가 먼저 finally 돌리면 옛 ws 의 finally가 새 슬롯 발견 → 그냥 return → 정상.

### 🟡 Cooldown 갱신 시점이 너무 빠를 수도
- 검사 통과 직후 갱신 → LLM 호출 실패해도 cooldown 소비. 사용자가 3초 기다린 뒤 재시도해야 함.
- Trade-off: spam 차단 vs 실패 후 즉시 재시도. 현재 spam 차단 우선.

### 🟡 Monster 부분 매칭 — 모호한 케이스
- "고블린"과 "고블린 궁수" 둘 다 있을 때 "고블린" 입력 → 정확 매칭으로 첫 번째 선택. OK.
- "고블린"만 있을 때 "고블린 A" 입력 → 부분 매칭으로 "고블린" 선택. 의도와 다를 수 있지만 1개 후보라 안전 측면 OK.

### 🟢 XSS 수정은 무해
- escapeHtml 적용은 항상 안전. 잘못 적용해도 표시만 약간 깨짐.

### 🟢 from_save_dict clamp 는 호환성 보존
- 기존 정상 save 는 그대로 통과. 손상된 save 만 default 로 폴백.

---

## 검증 체크리스트

- [ ] 같은 캐릭터로 두 탭 열어보기 → 두 번째 탭 열면 첫 번째에 `session_replaced` 알림 + close
- [ ] 빠른 액션 5번 연타 → 처음 1개만 처리, 나머지 4개 cooldown 에러
- [ ] DM 이 [적 등장: X | HP 99999] 찍으면 → 1000 으로 clamp 됨
- [ ] 잘못된 save 파일 (수동으로 hp:-100 편집) → default 로 복원, 크래시 없음
- [ ] 닉네임에 `"><script>alert(1)</script>` 입력 시도 → 텍스트로만 표시, 스크립트 실행 안 됨
- [ ] 서버 강제 종료 → 클라가 3s, 6s, 12s … 백오프로 재시도

---

## 변경 파일
- `trog/main.py` — 6개 위치 수정 (`_assign_player_connection`, finally race guard, cooldown 갱신 2곳, monster spawn 검증, monster fuzzy match, Player.from_save_dict clamp)
- `trog/static/game.js` — 3개 함수 수정 (`connect`, `scheduleReconnect`, `_detachWsHandlers` 신규, `refreshPlayers`/`refreshCharPanel` escapeHtml)
