"""A-2 AFK 자동 스킵 판정 단위 체크 — 프레임워크 없이 assert. `python _test_afk_skip.py`.
_afk_turn_should_skip 순수 판정: turn_started_at 과거 조작→True, 방금 행동/처리중/무연결/탐색중→False."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import main  # noqa: E402


def _make_started_room():
    r = main.GameRoom("AFKTST")
    r.players["p1"] = main.Player("p1", "가", "전사", race="인간")
    r.players["p2"] = main.Player("p2", "나", "전사", race="인간")
    r.turn_order = ["p1", "p2"]
    r.started = True
    r.ensure_round_started()          # round_order 구축 → 현재 actor 는 플레이어
    r.connections["p1"] = object()    # 살아있는 연결 (truthy 이기만 하면 됨)
    assert r.current_turn_player_id() is not None, "현재 actor 가 플레이어여야 테스트 성립"
    return r


def test_afk_should_skip():
    r = _make_started_room()
    now = main.time.time()

    # 방금 턴 시작 (막 시작) → 스킵 안 함
    r.turn_started_at = now
    r._action_in_flight = False
    assert main._afk_turn_should_skip(r, now) is False, "막 시작한 턴은 스킵 대상 아님"

    # turn_started_at 을 과거로 조작 (SKIP 초과) → 스킵 True
    r.turn_started_at = now - (main.TURN_AFK_SKIP_SEC + 5)
    assert main._afk_turn_should_skip(r, now) is True, "초과 방치는 스킵 대상"

    # 행동 직후 = 처리 중 가드 → 초과여도 False (스킵 중복/처리중 방지)
    r._action_in_flight = True
    assert main._afk_turn_should_skip(r, now) is False, "처리 중이면 스킵 금지"
    r._action_in_flight = False

    # 연결 없음 → False (아무도 안 봄, 스킵 의미 없음)
    saved = dict(r.connections)
    r.connections.clear()
    assert main._afk_turn_should_skip(r, now) is False, "연결 없으면 스킵 안 함"
    r.connections.update(saved)

    # 탐색 진행 중 → False
    r.exploration = {"active": True}
    assert main._afk_turn_should_skip(r, now) is False, "탐색 중이면 스킵 안 함"
    r.exploration = None

    # 게임 미시작 → False
    r.started = False
    assert main._afk_turn_should_skip(r, now) is False, "미시작 방은 스킵 안 함"
    r.started = True

    # 재확인: 조건 원복 후 다시 True
    assert main._afk_turn_should_skip(r, now) is True
    print("test_afk_should_skip OK")


def test_mark_turn_started_resets_warn():
    r = _make_started_room()
    r._afk_warned_token = "someoldtoken"
    r.advance_turn()   # 턴 전환 → _mark_turn_started 호출
    assert r._afk_warned_token is None, "턴 전환 시 경고 토큰 리셋"
    assert abs(main.time.time() - r.turn_started_at) < 1.0, "턴 전환 시 turn_started_at 갱신"
    print("test_mark_turn_started_resets_warn OK")


def test_record_monster_fallback():
    """A-3 — 몬스터턴 폴백: 생존 몬스터+플레이어면 서사 반환+히스토리 append, 아니면 None."""
    import asyncio
    r = _make_started_room()
    r.monsters["고블린"] = main.Monster("고블린", 20)
    before = len(r.messages)
    text = asyncio.run(r.record_monster_fallback("고블린"))
    assert text and "고블린" in text, f"폴백 서사에 이름 포함: {text!r}"
    assert len(r.messages) == before + 1 and r.messages[-1]["role"] == "assistant", "히스토리에 남겨야 함"
    # 죽은 몬스터 → None (정당한 빈응답, 폴백 안 함)
    r.monsters["고블린"].hp = 0
    assert asyncio.run(r.record_monster_fallback("고블린")) is None, "죽은 몬스터는 폴백 없음"
    # 없는 몬스터 → None
    assert asyncio.run(r.record_monster_fallback("없는몬스터")) is None
    print("test_record_monster_fallback OK")


if __name__ == "__main__":
    test_afk_should_skip()
    test_mark_turn_started_resets_warn()
    test_record_monster_fallback()
    print("ALL AFK SKIP TESTS PASSED")
