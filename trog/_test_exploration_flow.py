"""탐색 로직 통합 체크 — 실제 GameRoom/Player 객체로 탭→아이템 인벤 반영→골드→함정→완주/적조우
전체 흐름을 LLM 없이(폴백 각본으로) 검증. `python _test_exploration_flow.py`.
WS 왕복은 배선일 뿐이고 상태 변화 로직은 이 테스트가 커버."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import main  # noqa: E402


def _mk_room():
    room = main.GameRoom("TEST01")
    room.started = True
    p = main.Player("p1", "테스터", "전사")
    room.attach_player(p)
    room.owner_id = "p1"
    return room, p


def _seed_exploration(room, cells):
    import time
    room.exploration = {
        "place": "테스트 던전", "danger": "상", "cells": cells,
        "pos": 0, "active": True, "started_at": time.time(),
        "last_activity_at": time.time(), "last_tap_at": {}, "image_url": None, "gained": [],
    }


def test_item_and_gold_and_trap():
    """각 칸 타입이 실제 인벤/골드/HP 에 반영되는지."""
    room, p = _mk_room()
    p.gold = 100
    p.hp = 50
    cells = [
        {"type": "flavor", "text": "바람"},
        {"type": "item", "name": "빛나는 단검", "slot": "무기"},
        {"type": "gold", "amount": 30},
        {"type": "trap", "text": "가시!", "damage": 15},
        {"type": "empty"},
    ]
    _seed_exploration(room, cells)
    for _ in range(len(cells)):
        room.exploration["last_tap_at"] = {}  # 0.3초 쿨다운 우회
        room.exploration["last_step_at"] = 0.0  # 방 공용 0.35초 게이트도 우회
        tap = room.apply_explore_tap("p1")
        assert tap is not None, "탭이 무효 처리됨"
    # 아이템 인벤 반영 (자동 장착이면 equipped 슬롯, 아니면 inventory)
    has_dagger = p.has_item("빛나는 단검") or any(
        (p.equipped.get(s) or {}).get("name") == "빛나는 단검"
        for s in ("main_hand", "off_hand", "armor", "accessory")
    )
    assert has_dagger, f"단검 미반영. inv={p.inventory} equipped={p.equipped}"
    # 골드 +30
    assert p.gold == 130, f"골드 {p.gold} != 130"
    # 함정 HP -15 (최소 1 보장 확인은 아래 별도)
    assert p.hp == 35, f"HP {p.hp} != 35"
    # 완주 판정 (마지막 탭에서 ended)
    assert room.exploration is None or not room.exploration.get("active"), "완주 후에도 active"
    print("test_item_and_gold_and_trap OK")


def test_trap_no_death():
    """함정으로는 죽지 않음 — 최소 1 HP 보장."""
    room, p = _mk_room()
    p.hp = 5
    _seed_exploration(room, [{"type": "trap", "text": "깊은 구덩이", "damage": 999}])
    room.exploration["last_tap_at"] = {}
    room.apply_explore_tap("p1")
    assert p.hp == 1, f"함정 사망 방지 실패 HP={p.hp}"
    print("test_trap_no_death OK")


def test_complete_note():
    """완주 시 시스템 노트가 히스토리에 남는지 (DM 이어받기용)."""
    room, p = _mk_room()
    cells = [{"type": "gold", "amount": 10}, {"type": "empty"}]
    _seed_exploration(room, cells)
    end_payload = None
    for _ in range(len(cells)):
        room.exploration["last_tap_at"] = {}
        room.exploration["last_step_at"] = 0.0
        tap = room.apply_explore_tap("p1")
        if tap["ended"]:
            end_payload = room.finalize_exploration(tap["end_reason"])
    assert end_payload and end_payload["reason"] == "complete", end_payload
    assert any("탐색 완료" in m.get("content", "") for m in room.messages), "완주 노트 누락"
    assert room.exploration is None, "완주 후 exploration 미정리"
    print("test_complete_note OK")


def test_enemy_encounter():
    """적 조우 시 몬스터가 실제 등록되고 탐색이 중단되는지."""
    room, p = _mk_room()
    cells = [{"type": "empty"}, {"type": "enemy", "name": "동굴 트롤", "hp": 60}, {"type": "gold", "amount": 5}]
    _seed_exploration(room, cells)
    end_payload = None
    for _ in range(len(cells)):
        room.exploration["last_tap_at"] = {}
        room.exploration["last_step_at"] = 0.0
        tap = room.apply_explore_tap("p1")
        if tap["ended"]:
            enemy_cell = None
            if tap["end_reason"] == "enemy":
                enemy_cell = {"name": tap["event"].get("name"), "hp": tap["event"].get("hp")}
            end_payload = room.finalize_exploration(tap["end_reason"], enemy_cell)
            break
    assert end_payload and end_payload["reason"] == "enemy", end_payload
    # 몬스터 실제 등록 확인 (기존 몬스터 시스템에 합류)
    assert any("트롤" in k for k in room.monsters), f"몬스터 미등록 {list(room.monsters)}"
    # 조우 노트
    assert any("조우" in m.get("content", "") for m in room.messages), "조우 노트 누락"
    print("test_enemy_encounter OK")


def test_tap_cooldown():
    """0.3초 개인 쿨다운 — 즉시 재탭은 무효."""
    room, p = _mk_room()
    _seed_exploration(room, [{"type": "empty"}] * 5)
    t1 = room.apply_explore_tap("p1")
    t2 = room.apply_explore_tap("p1")  # 쿨다운 미경과 → None
    assert t1 is not None and t2 is None, f"쿨다운 미작동 t1={t1} t2={t2}"
    print("test_tap_cooldown OK")


def test_dead_player_blocked():
    """사망자는 탭 불가."""
    room, p = _mk_room()
    p.hp = 0
    _seed_exploration(room, [{"type": "empty"}] * 3)
    assert room.apply_explore_tap("p1") is None, "사망자 탭이 허용됨"
    print("test_dead_player_blocked OK")


def test_room_tap_gate():
    """방 공용 0.35초 게이트 — 한 명 탭 직후 다른 사람 탭은 무효 (동시 난타 방지)."""
    room, p = _mk_room()
    p2 = main.Player("p2", "둘째", "전사")
    room.attach_player(p2)
    _seed_exploration(room, [{"type": "empty"}] * 5)
    t1 = room.apply_explore_tap("p1")
    t2 = room.apply_explore_tap("p2")  # 다른 사람이라 개인 쿨다운엔 안 걸리지만 방 게이트에 막힘
    assert t1 is not None and t2 is None, f"방 게이트 미작동 t1={t1} t2={t2}"
    print("test_room_tap_gate OK")


if __name__ == "__main__":
    test_item_and_gold_and_trap()
    test_trap_no_death()
    test_complete_note()
    test_enemy_encounter()
    test_tap_cooldown()
    test_dead_player_blocked()
    test_room_tap_gate()
    print("ALL EXPLORATION FLOW TESTS PASSED")
