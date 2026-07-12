"""탐색 미니게임 단위 체크 — 프레임워크 없이 assert. `python _test_exploration.py`.
파서(정상/생략/trailing space/clamp/무효) + 각본 검증기(칸수 수리·enemy 캡·값 clamp·sanitize) + 폴백."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import main  # noqa: E402


def test_parse():
    r = main.parse_exploration_tag("들어간다. [탐색: 폐허가 된 성채 | 12칸 | 위험도 상]")
    assert r == {"place": "폐허가 된 성채", "cells": 12, "danger": "상"}, r
    # 칸수·위험도 생략 → 기본 10칸·중
    r = main.parse_exploration_tag("[탐색: 어두운 동굴]")
    assert r["place"] == "어두운 동굴" and r["cells"] == 10 and r["danger"] == "중", r
    # trailing space (REVIEW_2026-05-11 교훈)
    r = main.parse_exploration_tag("[탐색: 숲 | 8칸 ]")
    assert r["cells"] == 8, r
    # 칸수 clamp 6~16
    assert main.parse_exploration_tag("[탐색: 큰 성 | 99칸]")["cells"] == 16
    assert main.parse_exploration_tag("[탐색: 좁은 방 | 2칸]")["cells"] == 6
    # 위험도 별칭 관대 처리
    assert main.parse_exploration_tag("[탐색: 방 | 위험도 높음]")["danger"] == "상"
    assert main.parse_exploration_tag("[탐색: 방 | 위험도 극악]")["danger"] == "중"  # 미지 → 중
    # 없음
    assert main.parse_exploration_tag("그냥 텍스트") is None
    print("test_parse OK")


def test_strip():
    s = main.strip_exploration_tag("안으로 들어선다.\n[탐색: 성 | 10칸 | 위험도 중]")
    assert "[탐색" not in s and "안으로" in s, s
    print("test_strip OK")


def test_normalize():
    raw = [
        {"type": "flavor", "text": "바람이 분다"},
        {"type": "item", "name": "검", "slot": "무기"},
        {"type": "gold", "amount": 9999},          # clamp → 200
        {"type": "trap", "text": "함정", "damage": 50},  # clamp → 10
        {"type": "enemy", "name": "구울", "hp": 40},
        {"type": "enemy", "name": "두번째", "hp": 30},   # 2번째 enemy → empty
        {"type": "unknown"},                        # skip
    ]
    out = main._normalize_exploration_cells(raw, 10)
    assert len(out) == 10, len(out)                 # 부족분 empty 채움
    assert out[2]["amount"] == 200, out[2]
    assert out[3]["damage"] == 10, out[3]
    assert len([c for c in out if c["type"] == "enemy"]) == 1  # enemy 최대 1
    # 초과 자르기
    assert len(main._normalize_exploration_cells([{"type": "empty"}] * 20, 6)) == 6
    # 이름 sanitize (태그 오염 문자 제거)
    o = main._normalize_exploration_cells([{"type": "item", "name": "나쁜]|이름"}], 3)
    assert "]" not in o[0]["name"] and "|" not in o[0]["name"], o[0]
    print("test_normalize OK")


def test_danger_trap_clamp():
    # D-2: 위험도별 함정 피해 clamp — 하/중 1~10, 상 4~15.
    raw = [{"type": "trap", "text": "함정", "damage": 50},   # 상한 테스트
           {"type": "trap", "text": "함정", "damage": 1}]     # 하한 테스트
    out_mid = main._normalize_exploration_cells(raw, 4, "중")
    assert out_mid[0]["damage"] == 10 and out_mid[1]["damage"] == 1, out_mid
    out_hi = main._normalize_exploration_cells(raw, 4, "상")
    assert out_hi[0]["damage"] == 15 and out_hi[1]["damage"] == 4, out_hi  # 상: 4~15
    print("test_danger_trap_clamp OK")


def test_fallback():
    for danger in ("하", "중", "상"):
        s = main._fallback_exploration_script("테스트 장소", 10, danger)
        assert len(s["cells"]) == 10, (danger, len(s["cells"]))
        assert any(c["type"] in ("item", "gold", "trap", "enemy") for c in s["cells"]), danger
    # 상 위험도엔 enemy 배치 + 골드 30~90 + 함정 4~15 (여러 번 돌려 랜덤 범위 확인)
    for _ in range(20):
        s = main._fallback_exploration_script("위험한 곳", 12, "상")
        assert any(c["type"] == "enemy" for c in s["cells"])
        for c in s["cells"]:
            if c["type"] == "gold":
                assert 30 <= c["amount"] <= 90, c
            if c["type"] == "trap":
                assert 4 <= c["damage"] <= 15, c
    print("test_fallback OK")


def test_sanitize():
    assert main._sanitize_explore_name("정상") == "정상"
    assert main._sanitize_explore_name("[나쁜]|것") == "나쁜것"
    assert len(main._sanitize_explore_name("가" * 100)) == 40
    print("test_sanitize OK")


def test_scene_stages():
    # 정상 3개
    assert main._parse_scene_stages({"scene_stages": ["a", "b", "c"]}) == ["a", "b", "c"]
    # 과잉 → 3개로 자름, 비문자열/공백 원소 제거
    assert main._parse_scene_stages({"scene_stages": ["a", " ", 5, "b", "c", "d"]}) == ["a", "b", "c"]
    # 부족 → 있는 것만
    assert main._parse_scene_stages({"scene_stages": ["only"]}) == ["only"]
    # scene_en 하위호환 → stages[0]
    assert main._parse_scene_stages({"scene_en": "legacy"}) == ["legacy"]
    # 전부 없음 → []
    assert main._parse_scene_stages({}) == []
    assert main._parse_scene_stages({"scene_stages": "not a list"}) == []
    print("test_scene_stages OK")


def test_terrain():
    # 키워드 매핑
    assert main._terrain_from_place("폐허가 된 성채") == "stone"
    assert main._terrain_from_place("깊은 숲") == "grass"
    assert main._terrain_from_place("버려진 저택") == "wood"
    assert main._terrain_from_place("어두운 동굴") == "cave"
    assert main._terrain_from_place("넓은 들판") == "dirt"       # 미지 → dirt
    assert main._terrain_from_place("지하실 창고") == "stone"    # 지하실은 지하(cave)보다 먼저 stone
    # 폴백 각본에 terrain 포함 + 허용 5종
    s = main._fallback_exploration_script("무너진 신전", 8, "중")
    assert s["terrain"] == "stone", s["terrain"]
    assert s["terrain"] in main._EXPLORE_TERRAINS
    print("test_terrain OK")


def test_enemy_late_placement():
    # 앞쪽(idx 0) enemy → 후반 40%(idx>=6) 로 이동
    raw = [{"type": "enemy", "name": "고블린", "hp": 20}] + [{"type": "empty"}] * 9
    out = main._normalize_exploration_cells(raw, 10)
    ei = next(i for i, c in enumerate(out) if c["type"] == "enemy")
    assert ei >= 6, f"enemy 앞쪽 잔류 idx={ei}"
    assert len([c for c in out if c["type"] == "enemy"]) == 1
    # 이미 후반(idx 8)이면 그대로 유지
    raw2 = [{"type": "empty"}] * 8 + [{"type": "enemy", "name": "트롤", "hp": 40}, {"type": "empty"}]
    out2 = main._normalize_exploration_cells(raw2, 10)
    assert out2[8]["type"] == "enemy", out2
    # 헬퍼 직접 — 앞쪽 enemy 를 후반 empty 와 스왑 (in-place)
    cells = [{"type": "enemy", "name": "x", "hp": 10}, {"type": "flavor", "text": "a"},
             {"type": "empty"}, {"type": "empty"}, {"type": "empty"}]
    main._reposition_enemy_late(cells)
    assert cells[0]["type"] != "enemy" and any(c["type"] == "enemy" for c in cells[3:]), cells
    print("test_enemy_late_placement OK")


def test_explore_intent():
    assert main._is_explore_intent_action("이 장소를 본격적으로 샅샅이 탐색하며 나아간다") is True
    assert main._is_explore_intent_action("샅샅이 뒤진다") is True
    assert main._is_explore_intent_action("주변을 조심스럽게 살펴본다") is False
    assert main._is_explore_intent_action("적을 공격한다") is False
    print("test_explore_intent OK")


if __name__ == "__main__":
    test_parse()
    test_strip()
    test_normalize()
    test_danger_trap_clamp()
    test_fallback()
    test_sanitize()
    test_scene_stages()
    test_terrain()
    test_enemy_late_placement()
    test_explore_intent()
    print("ALL EXPLORATION TESTS PASSED")
