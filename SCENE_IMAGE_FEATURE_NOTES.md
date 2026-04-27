# 장면 자동 이미지 (LLM SCENE 태그) — 설계·구현·리뷰

## 핵심 설계 결정

### 왜 "DM 이 영문으로 SCENE 태그 발급" 방식?
대안 비교:

| 접근 | 장점 | 치명적 단점 |
|---|---|---|
| 한글 본문 그대로 인코딩 | 단순 | Flux 는 한글 거의 무시 → 그림 엉망 |
| 한글 → 영어 사전 매핑 | 외부 호출 0 | 어휘 한정, 뉘앙스 손실 |
| 별도 LLM 호출로 영문 prompt 생성 | 정확도 ↑ | LLM 콜 2배, 5~10초 추가 지연 |
| **DM 응답에 영문 SCENE 태그 강제 (채택)** | LLM 한 번에 본문+장면 묘사. 추가 콜 0. 영문이라 모델 친화적 | LLM 이 태그 누락하면 이미지 없음 (graceful fallback 으로 해결) |

DM 이 자기가 묘사한 장면의 핵심을 직접 골라 영문으로 쓰는 게 **정확도·비용·지연** 모두 최선. Claude/Sonnet 은 영어 시각 묘사를 잘 씀.

---

## 변경 파일

### Backend (`trog/main.py`)

**1. `DM_SYSTEM_PROMPT` — SCENE 태그 지시사항 추가** (필수 포맷 섹션)
- 응답 마지막 줄에 `[🎬 SCENE: <영문 묘사>]` 강제
- 영어 only, 30~60단어, 핵심 시각 요소만
- 금지어: text/letters/words/numbers/UI (그림에 글자 박힘 방지)
- 고유 캐릭터 이름 금지 (모델이 이상 해석)
- 폭력적 묘사 암시 수준만 (모델 검열 회피)

**2. 새 함수들** (parse_time_tag 근처)
- `SCENE_PATTERN` — `[🎬 SCENE: ...]` 정규식
- `_is_safe_scene_desc(desc)` — 한글 비율 30% 초과시 폐기, 길이 8~350, 검열 위험어 차단
- `parse_scene_tag(text)` — 본문에서 영문 묘사 추출
- `strip_scene_tag(text)` — 사용자 화면 표시용 본문에서 태그 제거 (LLM history 의 raw text 는 유지)
- `build_scene_image_url(desc, seed)` — Pollinations URL + 일관된 스타일 suffix 부여
- `extract_scene_payload(text)` — 한 번에 (clean_text, scene_image_url, scene_desc) 반환

**3. `GameRoom`**
- `current_scene_url` 필드 추가
- `to_save_dict` / `from_save_dict` 에 직렬화

**4. 브로드캐스트 5곳에 scene 처리 적용**
- `game_started` (intro)
- `dm_response` × 2 (linger + 일반 액션)
- `monster_turn`
- `joined_room` / `rejoin_ok` / `joined_as_spectator` 응답에 `current_scene_url` 포함

### Frontend (`trog/static/game.js`)

**1. `updateSceneBanner(dmText, timeTag, players, directUrl)`**
- 4번째 인자 `directUrl` 추가 (서버가 발급한 LLM SCENE URL)
- 있으면 그대로 사용 (한글 키워드 추출 스킵)
- 없으면 기존 동작 — `extractSceneKeywords` 로 한글 → 영문 폴백
- `onerror` 추가 — 그림 실패해도 배너 깨지지 않음

**2. 핸들러 갱신**
- `game_started` / `dm_response` / `monster_turn`: `d.scene_image_url` 가 있으면 매 응답마다 배너 갱신 (LLM 직접 발급)
- 없으면 기존 동작 (round_complete 시에만, 한글 키워드 추출 폴백)
- `joined_room` / `rejoin_ok`: `d.current_scene_url` 로 마지막 장면 즉시 복원

### `index.html`
- 캐시 버스터 `?v=3` → `?v=4`

---

## 비판적 셀프 리뷰 — 발견한 허점

### 🔴 LLM 이 SCENE 태그를 안 찍을 수 있다
프롬프트에 "필수" 지시했지만 보장 안 됨. 특히:
- 응답 길이 한도(max_tokens)에 걸려 마지막 줄 잘림 → 태그 절단
- LLM 이 다른 시스템 프롬프트(wrapper 모드의 Claude Code preset) 와 섞이면 지시 무시 가능
- 첫 몇 응답 후 익숙해지면 잊을 수도

**완화책 (이미 구현):**
- 태그 없으면 `extract_scene_payload` 가 None 반환 → 클라가 라운드 완료 시 한글 키워드 폴백 자동 발동
- 사용자에겐 무음 실패 (깨진 이미지 X)

**미구현 — 추후 개선:**
- 태그 누락이 N회 연속 발생하면 시스템 메모로 LLM 에 리마인더 주입
- max_tokens 잘림 감지 → 자동 재요청

### 🟡 Pollinations 자체 장애
- 서비스 다운 / 느려짐 / 검열 거부 → 빈 이미지
- 클라 `onerror` 가 배너 로딩 표시만 해제. 이전 이미지가 그대로 남음 (좋음)
- 더 좋은 UX: 실패 시 placeholder 이미지 한 장 띄우기. (현재 미구현)

### 🟡 여러 SCENE 태그가 한 응답에 있으면?
`finditer` 는 첫 매치만 사용. 다중 태그는 무시. 의도된 동작.

### 🟡 한글 검사가 비율 30% 기준 — 경계 케이스
`[🎬 SCENE: dark forest 어둠]` 같이 영어 위주 + 한글 한 단어면 통과.
Pollinations 가 한글 부분만 무시하고 영어 부분 처리 → 보통 OK. 큰 사고는 아님.

### 🟡 캐릭터 이름이 SCENE 에 들어가면?
프롬프트로 "고유 이름 금지" 지시했지만 LLM 이 무시 가능. 들어가면 모델이 "Heojeop" 을 무작위 글자로 해석.
**완화 안 됨.** 검출 로직 추가 가능 (플레이어 이름 사전과 비교) — 미구현. 우선순위 낮음.

### 🟡 Pollinations URL 길이
`urllib.parse.quote` 후 보통 600~1000자. WebSocket 프레임으로는 문제없음. 다만 매 응답마다 URL 갱신되어 트래픽 증가. 미미한 비용.

### 🟡 `monster_turn` 에서 `_lastSeenPlayers || []` 사용
LLM SCENE 모드에선 `directUrl` 만 있으면 players 인자 안 쓰니까 안전. 폴백(한글 키워드) 모드에선 `_lastSeenPlayers` 가 비어있으면 partyCue 가 비는데, 그래도 그림은 생성됨. 합당.

### 🟢 캐시 효과
같은 SCENE 묘사 + 같은 seed → 같은 URL → 브라우저가 자동 캐시. DM 이 비슷한 장면 반복하면 그림도 일관.

### 🟢 보안 — XSS 등
URL 은 `quote` 로 인코딩. img.src 에만 들어감. 이벤트 핸들러로 들어가지 않음 → XSS 없음.

### 🟢 LLM history 보존
`messages` 에 저장되는 텍스트는 SCENE 태그 포함 raw. LLM 이 자기 이전 태그 보고 일관성 유지 가능.

---

## 검증 체크리스트

- [ ] `Ctrl+F5` 강제 새로고침 (캐시 버스터 v4)
- [ ] 모험 시작 → 첫 응답 직후 상단 장면 배너에 새 그림 (5~10초 내 로드)
- [ ] 액션 보낼 때마다 배너 그림 갱신 (라운드 끝 아니어도)
- [ ] 그림이 영문 SCENE 묘사 기반이라 본문 분위기와 더 잘 맞는지 확인
- [ ] 새로고침/재접속 → 마지막 장면 즉시 복원 (last frame)
- [ ] LLM 이 가끔 태그 누락해도 게임 진행 OK (배너만 안 갱신될 뿐)
- [ ] 본문에서 `[🎬 SCENE: ...]` 태그가 화면에 노출되지 않음 (strip 됨)

## 다음 후보 개선

- 태그 누락 N회 연속 시 LLM 에 리마인더 시스템 메시지 주입
- 실패 시 한 장의 placeholder (안개 낀 숲 그림 등) 폴백
- 장면 변화 감지 — 같은 location 이면 이전 URL 유지 (트래픽 절감)
