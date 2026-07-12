"""패키지 E-2 진행 막(act) 단위 체크 — 프레임워크 없이 assert. `python _test_act_progress.py`.
[진행: N막] 태그 파싱(N=1~3만 유효), 중복 무시, 범위 밖 무시, 저장/복원 clamp, 본문 strip."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import main  # noqa: E402


def test_valid_transition():
    room = main.GameRoom("TESTACT")
    assert room.current_act == 1, room.current_act
    ev = room._parse_all_tags("문이 열린다. [진행: 2막]")
    assert room.current_act == 2, room.current_act
    assert ev["act_changed"] == 2, ev["act_changed"]
    print("test_valid_transition OK")


def test_repeat_same_act_no_toast():
    room = main.GameRoom("TESTACT")
    room._parse_all_tags("[진행: 2막]")
    ev = room._parse_all_tags("계속 같은 막 [진행: 2막]")   # 이미 2막 → 변경 없음
    assert room.current_act == 2, room.current_act
    assert ev["act_changed"] is None, ev["act_changed"]
    print("test_repeat_same_act_no_toast OK")


def test_out_of_range_ignored():
    room = main.GameRoom("TESTACT")
    room._parse_all_tags("[진행: 3막]")
    ev = room._parse_all_tags("[진행: 0막] [진행: 4막] [진행: 9막]")  # 전부 무효
    assert room.current_act == 3, room.current_act
    assert ev["act_changed"] is None, ev["act_changed"]
    print("test_out_of_range_ignored OK")


def test_intermediate_no_false_change():
    # [진행:1막]...[진행:2막] 인데 이미 2막이면 최종 불변 → act_changed 없어야 함(중간 매치 오발 방지)
    room = main.GameRoom("TESTACT")
    room._parse_all_tags("[진행: 2막]")
    ev = room._parse_all_tags("되돌아본다 [진행: 1막] 다시 나아간다 [진행: 2막]")
    assert room.current_act == 2, room.current_act
    assert ev["act_changed"] is None, ev["act_changed"]
    # 반대로 마지막이 실제 달라지면 그 값으로 1회 전환
    ev2 = room._parse_all_tags("[진행: 2막] 격변 [진행: 3막]")
    assert room.current_act == 3, room.current_act
    assert ev2["act_changed"] == 3, ev2["act_changed"]
    print("test_intermediate_no_false_change OK")


def test_save_load_clamp():
    room = main.GameRoom("TESTACT")
    room.current_act = 3
    d = room.to_save_dict()
    assert d["current_act"] == 3, d["current_act"]
    assert main.GameRoom.from_save_dict(d).current_act == 3
    # 구버전 save(필드 없음) → 1
    d.pop("current_act")
    assert main.GameRoom.from_save_dict(d).current_act == 1
    # 손상값 → 1..3 clamp
    d["current_act"] = 99
    assert main.GameRoom.from_save_dict(d).current_act == 3
    d["current_act"] = 0
    assert main.GameRoom.from_save_dict(d).current_act == 1
    print("test_save_load_clamp OK")


def test_strip_pattern():
    # 본문 노출 제거는 클라 formatDmInline 이 담당 — 서버 ACT_PATTERN 이 정확히 잡는지만 검증.
    stripped = main.ACT_PATTERN.sub("", "가자 [진행: 3막] 앞으로")
    assert not main.ACT_PATTERN.search(stripped), stripped
    assert "진행" not in stripped, stripped
    # 잘못된 형식은 안 잡음(그대로 남음)
    assert main.ACT_PATTERN.search("[진행: 5막]") is None
    print("test_strip_pattern OK")


if __name__ == "__main__":
    test_valid_transition()
    test_repeat_same_act_no_toast()
    test_out_of_range_ignored()
    test_intermediate_no_false_change()
    test_save_load_clamp()
    test_strip_pattern()
    print("\n✅ 모든 act 진행도 테스트 통과")
