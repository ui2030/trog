"""패키지 L 공동 낙서판 단위 체크 — 프레임워크 없이 assert. `python _test_doodle.py`.
획 검증(포인트 수·좌표 범위·색 화이트리스트·굵기)·캡 트림·clear 방장 가드·레이트리밋 drop·휘발성(save 제외)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import main  # noqa: E402

GOOD_COLOR = next(iter(main.DOODLE_COLORS))
GOOD_W = 3
assert GOOD_W in main.DOODLE_WIDTHS


def _room():
    return main.GameRoom("TESTDOO")


def test_valid_stroke_appended_and_rounded():
    room = _room()
    s = room.add_doodle_stroke("p1", GOOD_COLOR, GOOD_W, [[0.12345, 0.6789], [0.5, 0.5]])
    assert s is not None
    assert len(room.doodle) == 1
    assert s["pid"] == "p1"
    # 소수 3자리 반올림
    assert s["pts"][0] == [0.123, 0.679], s["pts"][0]
    print("test_valid_stroke_appended_and_rounded OK")


def test_point_count_bounds():
    room = _room()
    assert room.add_doodle_stroke("p", GOOD_COLOR, GOOD_W, [[0.1, 0.1]]) is None  # 1개 < 2
    assert room.add_doodle_stroke("p", GOOD_COLOR, GOOD_W, []) is None
    too_many = [[0.0, 0.0]] * (main.DOODLE_PTS_PER_STROKE + 1)
    assert room.add_doodle_stroke("p", GOOD_COLOR, GOOD_W, too_many) is None
    assert len(room.doodle) == 0
    print("test_point_count_bounds OK")


def test_coord_range_and_finite():
    room = _room()
    assert room.add_doodle_stroke("p", GOOD_COLOR, GOOD_W, [[0.0, 0.0], [1.0, 1.0]]) is not None  # 경계 허용
    assert room.add_doodle_stroke("p", GOOD_COLOR, GOOD_W, [[0.5, 0.5], [1.01, 0.5]]) is None  # >1
    assert room.add_doodle_stroke("p", GOOD_COLOR, GOOD_W, [[-0.01, 0.5], [0.5, 0.5]]) is None  # <0
    assert room.add_doodle_stroke("p", GOOD_COLOR, GOOD_W, [[float("nan"), 0.5], [0.5, 0.5]]) is None
    assert room.add_doodle_stroke("p", GOOD_COLOR, GOOD_W, [[float("inf"), 0.5], [0.5, 0.5]]) is None
    assert room.add_doodle_stroke("p", GOOD_COLOR, GOOD_W, [[0.5], [0.5, 0.5]]) is None  # 길이 오류
    assert len(room.doodle) == 1  # 경계 케이스만 통과
    print("test_coord_range_and_finite OK")


def test_color_and_width_whitelist():
    room = _room()
    assert room.add_doodle_stroke("p", "#abcabc", GOOD_W, [[0.1, 0.1], [0.2, 0.2]]) is None  # 색 아님
    assert room.add_doodle_stroke("p", GOOD_COLOR, 99, [[0.1, 0.1], [0.2, 0.2]]) is None  # 굵기 아님
    assert room.add_doodle_stroke("p", GOOD_COLOR, "3", [[0.1, 0.1], [0.2, 0.2]]) is not None  # 문자열 정수 허용
    assert len(room.doodle) == 1
    print("test_color_and_width_whitelist OK")


def test_stroke_cap_trim():
    room = _room()
    for _ in range(main.DOODLE_MAX_STROKES + 50):
        room._doodle_rate.clear()  # 레이트리밋 우회 (캡만 검증)
        room.add_doodle_stroke("p", GOOD_COLOR, GOOD_W, [[0.1, 0.1], [0.2, 0.2]])
    assert len(room.doodle) == main.DOODLE_MAX_STROKES, len(room.doodle)
    print("test_stroke_cap_trim OK")


def test_point_cap_trim():
    room = _room()
    big = [[0.0, 0.0]] * 200  # 획당 200 포인트
    n = (main.DOODLE_MAX_POINTS // 200) + 20
    for _ in range(n):
        room._doodle_rate.clear()
        room.add_doodle_stroke("p", GOOD_COLOR, GOOD_W, big)
    total = sum(len(s["pts"]) for s in room.doodle)
    assert total <= main.DOODLE_MAX_POINTS, total
    print("test_point_cap_trim OK")


def test_rate_limit_drop():
    room = _room()
    ok = 0
    for _ in range(main.DOODLE_RATE_MAX + 5):
        # now 고정 → 전부 같은 1초 창 안
        if room.add_doodle_stroke("p", GOOD_COLOR, GOOD_W, [[0.1, 0.1], [0.2, 0.2]], now=1000.0):
            ok += 1
    assert ok == main.DOODLE_RATE_MAX, ok
    # 창을 벗어난 시각이면 다시 허용
    assert room.add_doodle_stroke("p", GOOD_COLOR, GOOD_W, [[0.1, 0.1], [0.2, 0.2]], now=1002.0) is not None
    # 서로 다른 sender 는 독립 버킷
    assert room.add_doodle_stroke("q", GOOD_COLOR, GOOD_W, [[0.1, 0.1], [0.2, 0.2]], now=1000.0) is not None
    print("test_rate_limit_drop OK")


def test_clear_owner_guard():
    room = _room()
    room.owner_id = "owner1"
    assert room.can_clear_doodle("owner1") is True
    assert room.can_clear_doodle("someone") is False
    assert room.can_clear_doodle(None) is False
    assert room.can_clear_doodle("") is False
    print("test_clear_owner_guard OK")


def test_doodle_not_persisted():
    room = _room()
    room.add_doodle_stroke("p", GOOD_COLOR, GOOD_W, [[0.1, 0.1], [0.2, 0.2]])
    d = room.to_save_dict()
    assert "doodle" not in d, "낙서판은 휘발성 — save 직렬화에 넣지 않는다"
    print("test_doodle_not_persisted OK")


if __name__ == "__main__":
    test_valid_stroke_appended_and_rounded()
    test_point_count_bounds()
    test_coord_range_and_finite()
    test_color_and_width_whitelist()
    test_stroke_cap_trim()
    test_point_cap_trim()
    test_rate_limit_drop()
    test_clear_owner_guard()
    test_doodle_not_persisted()
    print("\n✅ 모든 낙서판 테스트 통과")
