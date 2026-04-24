# TROG — AI Dungeon Master

한국어 멀티플레이 TRPG. Claude가 던전 마스터를 맡고, 친구들과 방 코드를 공유해 함께 플레이한다.

## 한눈에 보기

- **FastAPI + WebSocket** 서버 (`main.py`)
- **바닐라 JS** 프론트엔드 (`static/`)
- **하이브리드 LLM 모드**:
  - `wrapper` — 혼자 테스트용. 로컬에 [claude-code-openai-wrapper](../claude-code-openai-wrapper/)를 띄워 Claude Code CLI 구독을 사용
  - `anthropic` — 친구랑 플레이. Anthropic API 키로 직통

## 빠른 시작

### 1. 의존성 설치
```bash
pip install -r requirements.txt
```

### 2. 환경 변수 설정
```bash
cp .env.example .env
# .env 편집: LLM_MODE, API 키, 모델명 등
```

### 3. 서버 실행
```bash
python main.py
# http://localhost:8080 으로 접속
```

### wrapper 모드로 실행하려면
먼저 상위 폴더의 `claude-code-openai-wrapper`를 8000 포트에 띄워야 한다:
```bash
cd ../claude-code-openai-wrapper && python run_win.py
# 다른 터미널에서
cd ../trog && python main.py
```

## 플레이 방법

1. 이름 + 직업 선택 → `새 방 만들기`
2. 방 코드(6자) 친구에게 공유
3. 모두 입장하면 방장이 `⚔️ 모험 시작!`
4. DM의 묘사에 따라 자유롭게 행동 입력 또는 빠른 행동 버튼 사용

## 게임 시스템

| 요소 | 동작 |
|---|---|
| **직업** | 전사 / 마법사 / 도적 / 성직자 — HP·공격·방어 기본값 |
| **종족** | 입장 시 랜덤 (8종). 톤·NPC 반응에 반영됨 |
| **HP** | DM이 `[이름 HP: X → Y]` 태그로 갱신 |
| **XP/레벨** | DM이 `[이름 XP +N]` 부여 → 서버가 자동 레벨업. Lv↑마다 max_hp +10, attack +2, 풀회복 |
| **아이템** | DM이 `[이름 획득: 아이템명]`으로 부여. 최근 3개는 파티 요약에도 노출 |
| **시간대** | 응답 첫 줄 `[🌅 새벽]` 등. 역행 방지 내장 |
| **초상화** | 종족+직업 기반 Pollinations.ai 자동 생성 — 또는 직접 그리기(캔버스) |
| **커스텀 행동** | 플레이어가 자주 쓰는 행동을 로컬에 저장 (우클릭으로 삭제) |

## 세션 복구

WebSocket 끊어지면 자동 재연결. 브라우저 탭 닫고 다시 와도 2시간 내엔 복구됨 (localStorage 기반).
새 캐릭터로 시작하려면 `http://localhost:8080?fresh=1`.

## 설계 메모

- **rooms는 메모리에만 존재** — 서버 재시작 = 캠페인 증발. 의도된 단순함.
- **메시지 히스토리**는 플레이어당 방당 최대 50개까지만 메모리 유지, LLM에는 최근 20개만 전송.
- **레이트리밋** 3초/플레이어 — LLM 호출 폭탄 방지.
- **정적 파일 캐시버스터**는 서버 기동 시각 기반 자동 주입. 코드 수정 후 서버 재시작만 하면 브라우저가 새로 로드함.

## 업데이트 기록

- [docs/CHANGELOG.md](docs/CHANGELOG.md) — 버전별 변경사항 통합
- [../FEATURE_UPDATE_V3_NOTES.md](../FEATURE_UPDATE_V3_NOTES.md) — 최신 세션 작업 노트
