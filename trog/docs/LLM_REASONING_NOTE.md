# LLM 추론(Reasoning) 모드 — 반드시 끄고 쓰기

## 한줄 요약
TROG 의 wrapper 모드(NVIDIA NIM 등)에서는 **하이브리드 추론 모델의 thinking 단계를 항상 꺼야 한다.** 켜져 있으면 매 턴 응답이 30~60초+ 로 늘어진다.

## 무엇이 문제였나
- `.env` 의 `WRAPPER_MODEL=z-ai/glm-5.1` (Zhipu GLM 5.x 시리즈) 은 **하이브리드 추론 모델**.
- 기본 동작: 답하기 전에 내부 reasoning 토큰을 수백~수천 개 생성한 뒤 본 응답.
- TROG 같이 매 턴마다 짧은(300~700 토큰) 서사를 빠르게 받아야 하는 게임에서는 **모든 호출이 30~60초+** 로 멈춰 보임.
- NIM 호스팅 콜드스타트 / 무료 티어 큐 문제로 오인하기 쉬움 — 실제로는 **모델 자체가 사고 중**.

## 진단 신호 (어떻게 알아챘나)
1. `LLMTimeoutError: LLM 응답 60s 초과` 가 콜드스타트 후에도 반복됨 (콜드스타트면 첫 호출만 느려야 함).
2. 스택트레이스가 `_receive_response_headers` 에서 멈춤 = 서버가 응답을 아직 생성 중.
3. `build.nvidia.com/z-ai/glm-5.1` 페이지에 **"Reasoning ON/OFF" 토글이 노출** → 이 모델이 추론 모드를 가진다는 결정적 단서.

> **앞으로 새 wrapper 모델 도입할 때 반드시 확인할 것**: build.nvidia.com 의 모델 페이지에 Reasoning 토글이 있는지. 있으면 하이브리드 추론 모델 → 아래 처리 필수.

## 적용된 수정
[main.py](../main.py) 의 `llm_complete` 가 wrapper 호출 시 `extra_body` 로 thinking 을 끈다:

```python
kwargs["extra_body"] = {
    "chat_template_kwargs": {"thinking": False, "enable_thinking": False},
}
```

- `thinking` 과 `enable_thinking` 두 키를 같이 보냄 — 모델/벤더마다 키 이름 다름 (GLM, Qwen3, Hunyuan 등 각자 다름).
- 모르는 키는 서버가 무시하므로 비-추론 모델에도 안전.
- 환경변수 `WRAPPER_DISABLE_THINKING=0` 으로 끄면 사고 단계 다시 활성 (디버그/품질비교용).

## 언제 추론을 다시 켤 만한가
거의 없음. 다만 다음 상황은 예외:
- **인트로 1회만 LLM 호출하고 끝** 같이 응답 한 번이 매우 중요한 케이스 — 이때만 한정적으로 켤 가치 있음.
- 일반 in-game 턴(3~10초 안에 답해야 하는 상황)에서는 절대 켜지 말 것.

## 관련 코드
- [main.py:48 `WRAPPER_DISABLE_THINKING`](../main.py)
- [main.py:55 `llm_complete`](../main.py)
- `.env` 의 `WRAPPER_MODEL` — 모델 바꿀 때 이 문서 확인할 것
