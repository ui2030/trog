"""패키지 O-2 동명 몬스터 개별 관리 단위 체크 — 프레임워크 없이 assert. `python _test_monster_naming.py`.
동명 스폰 자동 접미사(B/C…) + 부분일치 다수 후보 _find 선택(조용한 증발 방지)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import main  # noqa: E402


def test_duplicate_spawn_gets_suffix():
    monsters = {}
    text = ("[적 등장: 고블린 | HP 12]\n"
            "[적 등장: 고블린 | HP 12]\n"
            "[적 등장: 고블린 | HP 12]")
    evs = main.parse_and_apply_monsters(text, monsters)
    names = sorted(monsters.keys())
    assert names == ["고블린", "고블린 B", "고블린 C"], names
    # 3개 다 개별 스폰 이벤트로 브로드캐스트되어야 한다.
    spawn_names = sorted(e["name"] for e in evs if e["kind"] == "spawn")
    assert spawn_names == ["고블린", "고블린 B", "고블린 C"], spawn_names
    print("test_duplicate_spawn_gets_suffix OK")


def test_next_suffix_helper():
    monsters = {"슬라임": main.Monster("슬라임", 10)}
    assert main._next_monster_suffix("슬라임", monsters) == "슬라임 B"
    monsters["슬라임 B"] = main.Monster("슬라임 B", 10)
    assert main._next_monster_suffix("슬라임", monsters) == "슬라임 C"
    # B~Z 소진 시 None
    for c in "BCDEFGHIJKLMNOPQRSTUVWXYZ":
        monsters[f"슬라임 {c}"] = main.Monster(f"슬라임 {c}", 10)
    assert main._next_monster_suffix("슬라임", monsters) is None
    print("test_next_suffix_helper OK")


def test_find_multi_candidate_picks_first():
    # 정확 매칭이 없고 부분일치 후보가 2개 이상이면 조용히 증발(None)하지 말고 먼저 등장한 개체 선택.
    monsters = {}
    main.parse_and_apply_monsters(
        "[적 등장: 고블린 A | HP 12]\n[적 등장: 고블린 B | HP 12]", monsters)
    # 바 "고블린" HP 태그 — 정확 매칭 없음, 부분일치 [고블린 A, 고블린 B].
    main.parse_and_apply_monsters("[적 HP: 고블린 12 → 5]", monsters)
    assert monsters["고블린 A"].hp == 5, monsters["고블린 A"].hp
    assert monsters["고블린 B"].hp == 12, monsters["고블린 B"].hp  # 두 번째 개체는 안 건드림
    print("test_find_multi_candidate_picks_first OK")


def test_exact_match_still_wins():
    # 바 이름이 실제로 존재하면 부분일치보다 정확 매칭 우선.
    monsters = {}
    main.parse_and_apply_monsters(
        "[적 등장: 고블린 | HP 20]\n[적 등장: 고블린 궁수 | HP 12]", monsters)
    main.parse_and_apply_monsters("[적 HP: 고블린 20 → 8]", monsters)
    assert monsters["고블린"].hp == 8, monsters["고블린"].hp
    assert monsters["고블린 궁수"].hp == 12, monsters["고블린 궁수"].hp
    print("test_exact_match_still_wins OK")


if __name__ == "__main__":
    test_duplicate_spawn_gets_suffix()
    test_next_suffix_helper()
    test_find_multi_candidate_picks_first()
    test_exact_match_still_wins()
    print("\nALL MONSTER-NAMING TESTS PASSED")
