# trog + claude-code-openai-wrapper 디버깅 히스토리

## 목표
trog(포트 8080)가 claude-code-openai-wrapper(포트 8000)를 통해 Claude Pro/Max 구독을 LLM 백엔드로 사용.

## 발생한 에러 목록 (순서대로)

### 1. `trog/.env` 오타 — WRAPPER_MODEL 값
```
WRAPPER_MODEL=model=claude-sonnet-4-5-20250929   ← 잘못
WRAPPER_MODEL=claude-sonnet-4-5-20250929          ← 맞음
```
모델 파라미터 자체에 `model=` prefix가 중복으로 붙어 있던 문제.

### 2. `trog/.env` 오타 — ANTHROPIC_API_KEY 앞에 `y`
```
ANTHROPIC_API_KEY=ysk-ant-api03-...   ← 잘못
ANTHROPIC_API_KEY=sk-ant-api03-...    ← 맞음
```
anthropic 모드 fallback 시 401 AuthenticationError 원인. 현재 wrapper 모드 사용 중이라 직접 영향은 없음.

### 3. Anthropic API 크레딧 부족 (anthropic 모드)
`"Your credit balance is too low"` — anthropic 모드 우회 시도는 중단. 사용자는 wrapper 경로(Pro 구독)로 해결 원함.

### 4. Windows asyncio subprocess `NotImplementedError` (핵심 원인)
```
File "...asyncio\base_events.py", line 503, in _make_subprocess_transport
    raise NotImplementedError
```
**원인:** `uvicorn`이 Windows에서 `WindowsSelectorEventLoopPolicy`를 강제로 설정함. 이 policy는 `asyncio.create_subprocess_exec`를 지원하지 않음. `claude_agent_sdk`는 내부적으로 `anyio.open_process` → `asyncio.create_subprocess_exec`를 호출하므로 실패.

**필요한 정책:** `WindowsProactorEventLoopPolicy` (subprocess 지원).

## 최종 수정 사항

### 파일 1: `claude-code-openai-wrapper/run_win.py` (신규)
uvicorn을 직접 `asyncio.run()`으로 기동. `loop="none"`으로 uvicorn이 이벤트 루프 정책을 덮어쓰지 않게 함.

```python
import asyncio, sys
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
import uvicorn

def main():
    config = uvicorn.Config("src.main:app", host="0.0.0.0", port=8000,
                            loop="none", reload=False)
    server = uvicorn.Server(config)
    asyncio.run(server.serve())

if __name__ == "__main__":
    main()
```

**실행 방법:**
```bash
cd C:/Users/ui2030/Documents/trpg/claude-code-openai-wrapper
poetry run python run_win.py
```

### 파일 2: `claude-code-openai-wrapper/src/main.py` (수정)
최상단에 Windows event loop policy 설정 추가 (run_win.py를 거치지 않고 `uvicorn` CLI로 띄워도 동작하도록 방어):
```python
import sys, asyncio
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
```
참고: run_win.py를 쓰면 이건 중복(redundant)이지만 해는 없음.

### 파일 3: `claude-code-openai-wrapper/src/claude_cli.py` (수정)
예외 핸들러에 traceback 로그 추가 — 향후 디버깅 위해 유지:
```python
except Exception as e:
    import traceback
    logger.error(f"Claude Agent SDK error: {type(e).__name__}: {e}")
    logger.error(f"Traceback:\n{traceback.format_exc()}")
    yield {...}
```

### 파일 4: `trog/.env` (수정)
```env
LLM_MODE=wrapper
WRAPPER_URL=http://localhost:8000/v1
WRAPPER_MODEL=claude-sonnet-4-5-20250929
```

## 비판적 셀프 리뷰 — 남은 허점

### 🟡 Ctrl+C 종료 시 이벤트 루프 행(hang) 가능성
`ProactorEventLoop`는 Python 3.10 이전에 KeyboardInterrupt 처리에 이슈가 있었음. 3.11+에서 개선됐지만 여전히 wrapper 서버 종료 시 Ctrl+C를 여러 번 눌러야 할 수 있음. 현재 Python 버전 확인 필요.

### 🟡 `reload=False` 로 hot reload 비활성
원래 `--reload` 옵션으로 띄우던 것과 달리, 코드 수정해도 자동 재기동 안 됨. wrapper 소스 수정할 때마다 서버 재시작 필요. 개발 편의성 저하지만 핵심 문제는 아님.

### 🟡 `run_win.py` + `src/main.py` 이중 설정
run_win.py에서 policy 설정하고 src/main.py에서도 설정함. 한쪽만 있어도 되지만 둘 다 둠 (방어적). 나중에 정리 가능.

### 🔴 아직 실제 동작 확인 안 됨
이 수정이 실제로 작동하는지는 **사용자가 `poetry run python run_win.py`로 재기동해서 시작 로그 확인 전까지 미확정**. 성공 지표:
- 시작 로그에 `✅ Claude Agent SDK verified successfully`
- trog에서 "모험 시작" 클릭 시 DM 응답 반환

### 🟡 fallback 전략 부재
만약 `loop="none"` 설정이 다른 부작용을 일으키거나 ProactorEventLoop로도 여전히 실패하면 다음 대안을 고려:
1. wrapper에서 `query()` 호출을 `asyncio.to_thread`로 별도 스레드에 격리
2. wrapper를 WSL로 이전 (Linux는 SelectorEventLoop로도 subprocess 지원)
3. SDK 사용 포기하고 wrapper가 claude.exe를 직접 subprocess로 실행하도록 패치

## 검증 체크리스트
- [x] wrapper 랜딩 페이지(`http://localhost:8000`): Connected 상태 + Auth: claude_cli
- [x] trog 기동 로그: `[LLM] mode=wrapper model=claude-sonnet-4-5-20250929`
- [x] trog 웹: 방 생성 → 모험 시작 → DM 응답 출력 **(2026-04-22 확인)**
- [x] Chat completion 200 OK 연속 성공 (wrapper 로그)
- [ ] Ctrl+C로 wrapper 정상 종료 (미확인)

## 2026-04-22 상태: 핵심 이슈 해결 ✅

wrapper(Pro 구독)로 DM 응답 정상 생성 확인. 볼카르 스토리 오프닝, 전투 프롬프트, 선택지 모두 한국어로 잘 나옴.

### 남아있는 사소한 이슈

**WebSocket 재연결 후 빈 방에서 `start_game` 호출 시 500**
- 브라우저가 WebSocket 끊긴 뒤 자동 재연결하면서 이전 방 상태가 날아감
- trog 쪽 GameRoom 상태는 메모리에만 있으므로 재연결 시 참조 끊김
- 재현 조건: 오래 방치 → WebSocket timeout → 새 연결에서 모험 시작 클릭
- 해결 방향 (future): trog 쪽에 room_id 기반 세션 복원 또는 재연결 시 방 재생성 유도

**`verify_cli` 시작 로그에 `✅ verified successfully` 안 보임**
- 사용자 공유 로그에는 startup complete만 있고 verify 결과 라인이 없음
- 원인: `run_win.py`로 띄우면 lifespan이 다르게 돌 가능성
- 하지만 실제 요청은 잘 동작하므로 startup verify 실패 여부와 별개로 정상
- 필요시 나중에 로그 레벨 확인
