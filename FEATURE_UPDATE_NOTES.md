# trog 기능/퀄리티 업데이트 노트 (2026-04-22)

## 이번 업데이트 범위
1. **비동기 LLM 호출** — 이벤트 루프 블로킹 제거
2. **WebSocket 재연결 + 에러 복원력** — 연결 끊겨도 게임 유지
3. **HP 파싱 정교화** — LLM이 쓴 `[이름 HP: X → Y]`를 실제로 반영
4. **커스텀 캐릭터 그림** — 플레이어가 직접 그린 이미지를 프로필로 사용
5. **종족(Race) 시스템** — 입장 시 랜덤 배정, 초상화 프롬프트 반영

---

## 1. 비동기 LLM 호출

**변경:** [main.py:22-32](trog/main.py#L22-L32)
- `OpenAI` → `AsyncOpenAI`
- `anthropic.Anthropic` → `anthropic.AsyncAnthropic`
- `llm_complete`를 `async def`로 변경, 모든 호출부에 `await` 추가
- `GameRoom.lock = asyncio.Lock()` 추가 — 같은 방 안에서 LLM 호출이 뒤섞이지 않도록

**효과:** 한 플레이어가 DM 응답 기다리는 동안 다른 플레이어 요청/브로드캐스트/WebSocket 처리가 모두 동시에 진행됨.

---

## 2. WebSocket 재연결 + 에러 복원력

### 서버 변경
- `finally` 블록에서 **connection만 제거**, `players` 데이터는 유지 → 재접속 시 복원 가능
- 새 메시지 타입 `rejoin_room` ([main.py:322-351](trog/main.py#L322-L351))
  - `room_id` + `player_id` 검증
  - 성공 시 `rejoin_ok`에 방 전체 상태 + 마지막 DM 대사 포함해서 응답
  - 실패 시 `rejoin_failed` (방 없음/플레이어 없음)
- LLM 호출 모두 `try/except`로 감쌈 — 실패해도 연결 유지, `error` 메시지만 보냄
- 방장(owner)만 `start_game` 실행 가능하도록 권한 체크

### 클라이언트 변경
- **localStorage** `trog-session`에 `{room_id, player_id, ts}` 저장 (2시간 유효)
- **페이지 로드 시** 세션 있으면 자동 rejoin 시도 (조용히)
- **연결 끊김** 시 3초마다 rejoin 재시도
- `error` 메시지 → 대화 로그에 `⚠` 표시만, 연결은 유지

---

## 3. HP 파싱

**패턴** ([main.py:195](trog/main.py#L195)):
```python
HP_PATTERN = re.compile(r"\[([^\]]+?)\s*HP\s*[:：]\s*(\d+)\s*(?:→|->|=>|-)\s*(\d+)\]")
```
- `→`, `->`, `=>`, `-` 모두 허용
- 한/영 콜론 모두 허용

**적용:** `process_action` 이후 `parse_and_apply_hp(text, players)` 호출 → DM이 선언한 대로 `player.hp` 수정 (0과 max_hp 사이로 clamp).

**프롬프트 강제:** `DM_SYSTEM_PROMPT`에 "HP 변화는 반드시 [이름 HP: X → Y] 정확히 이 포맷으로 표기" 명시.

---

## 4. 커스텀 캐릭터 그림

### 백엔드
- `Player.custom_portrait` 필드 (data URL 저장)
- `effective_portrait()` → 커스텀 있으면 우선, 없으면 Pollinations URL
- 새 메시지 타입 `set_portrait` ([main.py:353-375](trog/main.py#L353-L375))
  - 1MB 용량 제한
  - `data:image/` 프리픽스 검증
- 저장 시 전체 방에 `portrait_updated` 브로드캐스트

### 프런트엔드
- `<canvas>` 384×384 (기존 포트레이트와 동일 비율)
- 툴: 브러시 4종 크기, 색 10종, 지우개, 전체 지우기
- 터치/마우스 모두 지원 (모바일 가능)
- 저장 시 JPEG 70% 품질로 압축 → 용량 절감
- 대기실에서 `🎨 내 캐릭터 직접 그리기` 버튼

---

## 5. 종족 시스템

**8종족:** 인간, 엘프, 드워프, 하플링, 오크, 티플링, 드래곤본, 놈

각 종족에 `emoji`, `portrait`(AI 프롬프트), `desc`(설명)를 지정.

**배정:** `Player.__init__`에서 `race`가 None이면 `pick_random_race()` — 매 입장마다 랜덤.

**초상화 프롬프트:** `build_portrait_url`이 종족+직업 프롬프트 합쳐서 Pollinations.ai에 요청 → 종족 외모(뾰족귀, 뿔, 비늘 등)가 그림에 반영됨.

**UI:**
- 엔트리 하단에 `💡 종족은 입장 시 무작위로 정해집니다` 안내
- 대기실 상단에 "당신의 종족이 정해졌습니다 — [엘프] 고귀한 숲의 수호자…" 큰 박스
- 대기/게임 화면의 카드에 종족 이모지 + 이름 표시

---

## 비판적 셀프 리뷰 — 남은 허점 & 위험

### 🔴 Race condition — `Player.__init__` 랜덤 종족
동일 이름+클래스로 재입장하면 **새 종족**이 뽑힘. 의도한 동작이지만, `rejoin_room`은 그대로 유지하므로 충돌 없음. 다만 `create_room`/`join_room`이 매번 `new Player()`를 만드는 점은 확인 필요.

### 🔴 WebSocket 무한 재연결 루프
현재 `scheduleReconnect`는 session 있으면 3초마다 계속 시도. 서버가 영구히 꺼진 상태면 브라우저가 계속 연결 시도 → 네트워크 낭비. **개선점:** 최대 시도 횟수 / 백오프.

### 🟡 `rejoin_failed` 시 전체 화면 리셋
방이 날아갔을 때 엔트리 화면으로 돌리는데, 이미 `game-screen.active` 상태면 CSS 충돌 가능. 현재 `style.display = ''`로 인라인 스타일 리셋하지만, `.show` 클래스들이 남아있을 수 있음. **테스트 필요.**

### 🟡 HP 파싱이 이름을 정확히 매칭해야 함
LLM이 "용사 랑랑"처럼 수식어 붙이면 매칭 안 됨. 현재는 정확 매칭만. **개선 가능:** `p.name in matched_name` 부분 매칭.

### 🟡 그림 브로드캐스트 용량
`portrait_updated`에 **모든 플레이어의 to_dict()**를 포함 → 각자 커스텀 포트레이트가 있으면 합계 용량이 수 MB 될 수 있음. 4인 파티 × 1MB = 4MB WebSocket 프레임. 작동은 하지만 비효율. **개선 가능:** 변경된 플레이어 하나만 전송 (`player_portrait_updated`).

### 🟡 `dm-typing` 오타 상태
`showDmTyping(true)`를 `start_game`/`sendRaw`에서 호출하지만, 서버 에러로 `error` 메시지만 올 때는 `showDmTyping(false)` 안 불림. 현재는 `error` 핸들러에서 false 호출하도록 넣어둠 ([game.js:173](trog/static/game.js#L173)). OK.

### 🟡 캔버스 배경색 지우개와 일치
지우개 색을 `#1c1c2e`로 하드코딩 — 캔버스 초기 배경색과 같게. 근본적으로는 `destination-out` 블렌딩 모드가 더 정확하지만, 배경이 단색이라 현재로도 충분.

### 🟢 방장이 disconnect 후 재입장해도 owner 유지
`owner_id`를 방에 저장 → 재접속 시 권한 복원. OK.

### 🟢 비동기 Lock
`room.lock`으로 같은 방 내부에서 LLM 호출이 순차 처리됨. 다른 방끼리는 병렬 가능. 적절함.

---

## 검증 체크리스트 (수동 테스트)

- [ ] 방 생성 → 대기실에 내 종족 박스 뜸
- [ ] `🎨 내 캐릭터 직접 그리기` → 모달 뜨고 그리기 가능
- [ ] 그림 저장 → 대기실 카드에 🎨 뱃지 + 내 그림
- [ ] 친구 입장 → 친구도 내 그림 보임
- [ ] 모험 시작 → DM 응답 정상
- [ ] 공격 액션 → `[이름 HP: 120 → 100]` 포맷으로 DM이 적어주고, HP 바 감소
- [ ] 브라우저 새로고침 → 자동으로 방에 재입장 + 마지막 DM 메시지 복원
- [ ] WebSocket 강제 종료 (서버 재시작) → 자동 재연결 시도
- [ ] 멀티플레이: 두 탭으로 각각 플레이어 만들어서 동시 액션 보내기 → 블로킹 없이 순차 처리

---

## 새 파일
- `trog/FEATURE_UPDATE_NOTES.md` (이 파일)

## 수정된 파일
- `trog/main.py` — 전면 개편
- `trog/static/index.html` — 그리기 모달 + 종족 박스
- `trog/static/game.js` — 세션 복원 + 그리기 + 에러 처리
- `trog/static/style.css` — 모달/종족/타이핑 스타일 추가
