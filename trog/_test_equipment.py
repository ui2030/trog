"""패키지 O-3 장비 슬롯 분류 단위 체크 — 프레임워크 없이 assert. `python _test_equipment.py`.
이름 기반 슬롯 교정 매트릭스 + generic 장비 미장착 보관 + import weapon 키 마이그레이션."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import main  # noqa: E402


def mk(name="검사"):
    return main.Player("id_" + name, name, "전사", "인간")


def test_name_slot_matrix():
    # 이름만으로 슬롯이 결정되는지 (kind 힌트 없이 None 에서 시작).
    cases = {
        "옷": "armor", "낡은 옷": "armor", "튜닉": "armor", "가죽 부츠": "armor",
        "강철 장갑": "armor", "체인메일": "armor", "판금 갑주": "armor", "가죽 조끼": "armor",
        "긴 코트": "armor",
        "장검": "main_hand", "녹슨 단검": "main_hand",
        "나무 방패": "off_hand",
        "은반지": "accessory",
    }
    for name, expected in cases.items():
        got = main._correct_slot_by_name(name, None)
        assert got == expected, (name, got, expected)
    # "옷감"(제작 재료)은 방어구가 아니어야 한다 — 부정 전방탐색 확인.
    assert main._correct_slot_by_name("고급 옷감", None) is None, main._correct_slot_by_name("고급 옷감", None)
    print("test_name_slot_matrix OK")


def test_generic_equip_kind_slot_none():
    # generic '장비' 키워드는 이제 slot None (예전 main_hand 디폴트 제거).
    kind, slot, _ = main._classify_item("장비", None)
    assert kind == "equipment" and slot is None, (kind, slot)
    print("test_generic_equip_kind_slot_none OK")


def test_cloth_classified_armor_into_inventory():
    # [P-1] 자동 장착 폐지 — 옷은 armor 로 분류되지만 장착이 아니라 소지품으로 간다.
    p = mk()
    players = {p.player_id: p}
    ev = main.parse_and_apply_items("[검사 획득: 낡은 옷 | 장비 | 방어 +2]", players)
    # 시작 장비(가죽 흉갑 등)는 그대로 — 획득한 '낡은 옷'이 armor 슬롯을 차지하지 않는다.
    assert (p.equipped.get("armor") or {}).get("name") != "낡은 옷", p.equipped
    assert any(it.get("name") == "낡은 옷" for it in p.inventory), p.inventory
    # slot 분류(장착 UI 용)는 armor 로 유지.
    assert any(e.get("slot") == "armor" and e.get("auto_equipped") is False for e in ev), ev
    print("test_cloth_classified_armor_into_inventory OK")


def test_weapon_and_shield_classified_into_inventory():
    # [P-1] 무기/방패 slot 분류는 유지하되 장착은 안 한다.
    p = mk()
    players = {p.player_id: p}
    ev1 = main.parse_and_apply_items("[검사 획득: 장검 | 무기 | 공격 +3]", players)
    ev2 = main.parse_and_apply_items("[검사 획득: 나무 방패 | 방어구 | 방어 +1]", players)
    # 획득품이 손 슬롯을 차지하지 않는다(시작 장비 유지).
    assert (p.equipped.get("main_hand") or {}).get("name") != "장검", p.equipped
    assert (p.equipped.get("off_hand") or {}).get("name") != "나무 방패", p.equipped
    inv = {it["name"] for it in p.inventory}
    assert {"장검", "나무 방패"} <= inv, p.inventory
    assert any(e.get("slot") == "main_hand" for e in ev1), ev1
    # 이름(방패)이 kind(방어구)를 눌러 off_hand 로 분류.
    assert any(e.get("slot") == "off_hand" for e in ev2), ev2
    print("test_weapon_and_shield_classified_into_inventory OK")


def test_generic_no_hint_kept_in_inventory():
    p = mk()
    players = {p.player_id: p}
    before = {k: (v or {}).get("name") for k, v in p.equipped.items()}
    ev = main.parse_and_apply_items("[검사 획득: 수상한 장치 | 장비 | 알 수 없는 힘]", players)
    # 어떤 슬롯에도 자동 장착되지 않는다.
    after = {k: (v or {}).get("name") for k, v in p.equipped.items()}
    assert before == after, (before, after)
    assert any(e.get("auto_equipped") is False for e in ev), ev
    assert any(it.get("name") == "수상한 장치" for it in p.inventory), p.inventory
    print("test_generic_no_hint_kept_in_inventory OK")


def test_import_weapon_key_migration():
    p = mk()
    sheet = {"equipped": {"weapon": {"name": "명검", "effect": "공격 +5"}}}
    main._apply_imported_sheet(p, sheet)
    # 'weapon' 이 아니라 main_hand 로 들어가야 equipment_bonuses 가 읽는다.
    assert (p.equipped.get("main_hand") or {}).get("name") == "명검", p.equipped
    assert "weapon" not in p.equipped or not (p.equipped.get("weapon") or {}).get("name"), p.equipped
    assert p.equipment_bonuses().get("attack") == 5, p.equipment_bonuses()
    print("test_import_weapon_key_migration OK")


if __name__ == "__main__":
    test_name_slot_matrix()
    test_generic_equip_kind_slot_none()
    test_cloth_classified_armor_into_inventory()
    test_weapon_and_shield_classified_into_inventory()
    test_generic_no_hint_kept_in_inventory()
    test_import_weapon_key_migration()
    print("\nALL EQUIPMENT TESTS PASSED")
