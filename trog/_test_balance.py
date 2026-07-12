"""패키지 C 밸런스 단위 체크 — 프레임워크 없이 assert. `python _test_balance.py`.
서버가 숫자를 쥔다: 골드/힐/XP/아이템 clamp + 미니 상점(shop_buy/use_potion)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import main  # noqa: E402


def mk(name="허접"):
    """전사/인간 기본 캐릭터 — gold 50, hp/max_hp 120, mp/max_mp 30."""
    return main.Player("id_" + name, name, "전사", "인간")


def test_gold_delta_cap():
    p = mk()
    players = {p.player_id: p}
    main.parse_and_apply_gold("[허접 골드 +50000]", players)
    assert p.gold == 50 + main.GOLD_DELTA_CAP, p.gold      # +2000 캡
    p.gold = 5000
    main.parse_and_apply_gold("[허접 골드 -50000]", players)
    assert p.gold == 5000 - main.GOLD_DELTA_CAP, p.gold     # -2000 캡
    print("test_gold_delta_cap OK")


def test_gold_set_cap():
    p = mk()
    players = {p.player_id: p}
    main.parse_and_apply_gold("[허접 골드: 50 → 5000000]", players)
    assert p.gold == main.GOLD_MAX_BALANCE, p.gold          # 절대설정 999,999 캡
    # 잔액 천장: 거의 만렙 골드에서 +2000 해도 캡 못 넘김
    p.gold = main.GOLD_MAX_BALANCE - 100
    main.parse_and_apply_gold("[허접 골드 +2000]", players)
    assert p.gold == main.GOLD_MAX_BALANCE, p.gold
    print("test_gold_set_cap OK")


def test_currency_gold_ceiling():
    # 통화 아이템→골드 변환 경로도 999,999 천장 준수 (골드 태그 파서 밖의 두번째 경로).
    p = mk()
    p.gold = 600_000
    players = {p.player_id: p}
    main.parse_and_apply_items("[허접 획득: 금화 주머니 x99 | 소모품 | 5000골드]", players)
    assert p.gold == main.GOLD_MAX_BALANCE, p.gold
    print("test_currency_gold_ceiling OK")


def test_heal_cap():
    p = mk()
    p.hp = 10
    players = {p.player_id: p}
    main.parse_and_apply_hp("[허접 HP: 10 → 120]", players)
    cap = int(p.max_hp * main.HEAL_TAG_FRACTION)            # 120*0.4 = 48
    assert p.hp == 10 + cap, p.hp                           # 58
    print("test_heal_cap OK")


def test_heal_multi_tag_cap():
    p = mk()
    p.hp = 10
    players = {p.player_id: p}
    # 한 응답에 힐 태그 2개 — 누적으로도 40% 초과 못 함
    main.parse_and_apply_hp("[허접 HP: 10 → 40] [허접 HP: 40 → 120]", players)
    cap = int(p.max_hp * main.HEAL_TAG_FRACTION)            # 48
    assert p.hp == 10 + cap, p.hp                           # 58, 96 아님
    print("test_heal_multi_tag_cap OK")


def test_damage_not_capped():
    p = mk()
    players = {p.player_id: p}
    main.parse_and_apply_hp("[허접 HP: 120 → 5]", players)  # 피해는 그대로
    assert p.hp == 5, p.hp
    print("test_damage_not_capped OK")


def test_xp_response_cap():
    p = mk()
    players = {p.player_id: p}
    events = main.parse_and_apply_xp("[허접 XP +999] [허접 XP +999]", players, p.player_id)
    granted = sum(e["granted"] for e in events)
    assert granted == main.XP_GAIN_MAX_PER_RESPONSE, granted   # 150 캡
    print("test_xp_response_cap OK")


def test_item_gain_cap():
    p = mk()
    players = {p.player_id: p}
    text = ("[허접 획득: 물약가 x1 | 소모품 | 효과] "
            "[허접 획득: 물약나 x1 | 소모품 | 효과] "
            "[허접 획득: 물약다 x1 | 소모품 | 효과] "
            "[허접 획득: 물약라 x1 | 소모품 | 효과]")
    gained = main.parse_and_apply_items(text, players)
    assert len(gained) == main.ITEM_GAIN_MAX_PER_RESPONSE, len(gained)   # 3 캡
    assert not any(it["name"] == "물약라" for it in p.inventory), "초과분 지급됨"
    print("test_item_gain_cap OK")


def test_auto_equip_cap():
    p = mk()
    players = {p.player_id: p}
    text = ("[허접 획득: 강철검 | 무기 | 공격 +5] "
            "[허접 획득: 강철도끼 | 무기 | 공격 +6]")
    gained = main.parse_and_apply_items(text, players)
    equipped = [g for g in gained if g.get("auto_equipped")]
    assert len(equipped) == main.AUTO_EQUIP_MAX_PER_RESPONSE, gained     # 1개만 자동 장착
    # 초과 장비는 인벤토리로
    assert any(it["name"] == "강철도끼" for it in p.inventory), "초과 장비 인벤 미수납"
    print("test_auto_equip_cap OK")


def test_shop_buy_and_insufficient():
    p = mk()
    p.gold = 50
    spec, err = main.try_shop_buy(p, "heal_s")              # 60G 필요, 50G 보유
    assert spec is None and err and p.gold == 50, (spec, err, p.gold)
    p.gold = 100
    spec, err = main.try_shop_buy(p, "heal_s")
    assert err is None and p.gold == 40, (err, p.gold)      # 60G 차감
    assert any(it["name"] == "회복 물약" for it in p.inventory), p.inventory
    print("test_shop_buy_and_insufficient OK")


def test_use_potion_bypasses_heal_cap():
    p = mk()
    p.hp = 10
    p.grant_item("고급 회복 물약", "HP 100 즉시 회복", 1, kind="consumable")
    spec, err, remaining = main.try_use_potion(p, "고급 회복 물약")
    # HP+100 그대로 적용 (C-2 40%=48 캡 우회). min(max_hp, 10+100)=110
    assert err is None and p.hp == 110, (err, p.hp)
    assert remaining == 0, remaining
    print("test_use_potion_bypasses_heal_cap OK")


def test_race_net_spread():
    # D-1: 종족 보정 면값 적용 → 순보정이 +2~+4 로 수렴 (인간 압도 제거).
    expected = {"인간": 3, "엘프": 2, "드워프": 2, "하플링": 2, "오크": 2,
                "티플링": 2, "드래곤본": 3, "놈": 2}
    for race, want in expected.items():
        p = main.Player("id_" + race, "테스터", "전사", race)
        before = sum(getattr(p, k) for k in main.ABILITY_KEYS)
        p.apply_race_modifiers()
        after = sum(getattr(p, k) for k in main.ABILITY_KEYS)
        assert after - before == want, (race, after - before, want)
    # 수인 동물별 순보정
    beast = {"늑대": 3, "여우": 4, "호랑이": 4, "고양이": 4, "토끼": 3, "곰": 3}
    for animal, want in beast.items():
        p = main.Player("id_" + animal, "테스터", "전사", "수인", race_animal=animal, race_ratio=50)
        before = sum(getattr(p, k) for k in main.ABILITY_KEYS)
        p.apply_race_modifiers()
        after = sum(getattr(p, k) for k in main.ABILITY_KEYS)
        assert after - before == want, (animal, after - before, want)
    print("test_race_net_spread OK")


def test_race_mod_idempotent():
    # 2회 적용해도 1회만 (기존 가드 유지 확인)
    p = main.Player("id_x", "테스터", "전사", "오크")
    first = p.apply_race_modifiers()
    assert first is not None
    assert p.apply_race_modifiers() is None
    print("test_race_mod_idempotent OK")


def test_revive_hp_cap():
    # D-3: HP 0 → 풀피 부활 태그가 와도 max_hp 30% 로 캡 + 깊은 부상 디버프.
    p = mk()
    p.hp = 0
    players = {p.player_id: p}
    main.parse_and_apply_hp("[허접 HP: 0 → 120]", players)
    cap = max(1, int(p.max_hp * main.REVIVE_HP_FRACTION))   # 120*0.3 = 36
    assert p.hp == cap, p.hp
    assert any(st["name"] == "깊은 부상" and st["kind"] == "디버프" for st in p.status_effects), p.status_effects
    print("test_revive_hp_cap OK")


def test_revive_cap_not_bypassed_by_followup_heal():
    # 부활 태그 뒤 같은 응답 후속 힐 태그가 30% 캡을 우회 못 함 (Codex MUST-FIX).
    p = mk()
    p.hp = 0
    players = {p.player_id: p}
    main.parse_and_apply_hp("[허접 HP: 0 → 120] [허접 HP: 36 → 120]", players)
    cap = max(1, int(p.max_hp * main.REVIVE_HP_FRACTION))   # 36
    assert p.hp == cap, p.hp                                 # 84 아님
    print("test_revive_cap_not_bypassed_by_followup_heal OK")


def test_use_potion_dead_refused():
    p = mk()
    p.hp = 0
    p.grant_item("회복 물약", "HP 40 즉시 회복", 1, kind="consumable")
    spec, err, _ = main.try_use_potion(p, "회복 물약")
    assert spec is None and err and p.hp == 0, (spec, err, p.hp)   # 사망자 거부
    print("test_use_potion_dead_refused OK")


if __name__ == "__main__":
    test_gold_delta_cap()
    test_gold_set_cap()
    test_currency_gold_ceiling()
    test_heal_cap()
    test_heal_multi_tag_cap()
    test_damage_not_capped()
    test_xp_response_cap()
    test_item_gain_cap()
    test_auto_equip_cap()
    test_shop_buy_and_insufficient()
    test_use_potion_bypasses_heal_cap()
    test_race_net_spread()
    test_race_mod_idempotent()
    test_revive_hp_cap()
    test_revive_cap_not_bypassed_by_followup_heal()
    test_use_potion_dead_refused()
    print("\nALL BALANCE TESTS PASSED")
