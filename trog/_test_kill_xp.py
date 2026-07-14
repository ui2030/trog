"""패키지 O-1 처치/어시스트 XP 단위 체크 — 프레임워크 없이 assert. `python _test_kill_xp.py`.
전투 중 행동자 전원 기여 기록 / killer=죽인 턴 행동자 / 어시스트 지급 / 한 턴 3킬 /
DOT 사망 시 last_damager 폴백을 검증한다."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import main  # noqa: E402


def mk_room(*names):
    room = main.GameRoom("t_killxp")
    ids = []
    for n in names:
        p = main.Player("id_" + n, n, "전사", "인간")
        room.players[p.player_id] = p
        ids.append(p.player_id)
    return room, ids


def test_all_actors_recorded_as_contributors():
    # 전투 중 살아있는 몬스터에 대해 행동한 사람 전원이 attackers 에 기록된다(공격 여부 무관).
    monsters = {}
    main.parse_and_apply_monsters("[적 등장: 고블린 | HP 30]", monsters, acting_player_id=None)
    gob = monsters["고블린"]
    # 핸들러가 LLM 호출 전에 하는 pre-combat note 를 흉내: p1(공격자)·p2(힐러) 둘 다 기록.
    gob.note_attacker("p1")
    gob.note_attacker("p2")
    assert gob.attackers == ["p1", "p2"], gob.attackers
    # 힐러는 실제 데미지가 없으므로 last_damager_id 는 갱신되지 않는다.
    assert gob.last_damager_id is None, gob.last_damager_id
    print("test_all_actors_recorded_as_contributors OK")


def test_killer_is_turn_actor_not_last_attacker():
    # attackers[-1] 이 마지막 행동자(p3=힐러)라도 killer 는 그 턴 실제 처치 행동자여야 한다.
    room, (p1, p2, p3) = mk_room("검사", "궁수", "힐러")
    ev = {"kind": "defeated", "name": "고블린", "max_hp": 30,
          "attackers": [p1, p2, p3], "killer": p1}
    out = room._distribute_kill_xp([ev])
    kinds = {e["name"]: e["kind"] for e in out}
    assert kinds[room.players[p1].name] == "kill", kinds
    assert kinds[room.players[p2].name] == "assist", kinds
    assert kinds[room.players[p3].name] == "assist", kinds
    # XP 수치 불변: kill=20+30//3=30, assist=max(5,min(50,30//3))=10
    amt = {e["name"]: e["amount"] for e in out}
    assert amt[room.players[p1].name] == 30, amt
    assert amt[room.players[p2].name] == 10, amt
    print("test_killer_is_turn_actor_not_last_attacker OK")


def test_assist_granted_via_full_parse_path():
    # parse_and_apply_monsters 가 defeated 이벤트에 killer 를 싣고, 방 파이프라인이 XP 를 지급한다.
    room, (p1, p2) = mk_room("검사", "마법사")
    main.parse_and_apply_monsters("[적 등장: 오크 | HP 60]", room.monsters, acting_player_id=None)
    ork = room.monsters["오크"]
    # 두 사람 다 전투 중 행동(pre-combat note). p2 가 마지막에 행동했지만 처치는 p1.
    ork.note_attacker(p1)
    ork.note_attacker(p2)
    evs = main.parse_and_apply_monsters("[적 HP: 오크 60 → 0]", room.monsters, acting_player_id=p1)
    defeated = [e for e in evs if e["kind"] == "defeated"][0]
    assert defeated["killer"] == p1, defeated
    assert set(defeated["attackers"]) == {p1, p2}, defeated
    out = room._distribute_kill_xp(evs)
    # max_hp 60 → kill=20+20=40, assist=max(5,min(50,40//3=13))=13
    amt = {e["name"]: (e["amount"], e["kind"]) for e in out}
    assert amt[room.players[p1].name] == (40, "kill"), amt
    assert amt[room.players[p2].name] == (13, "assist"), amt
    print("test_assist_granted_via_full_parse_path OK")


def test_three_kills_one_turn_each_gives_assist():
    # 한 턴에 p1 이 3마리를 처치. 다른 기여자 p2·p3 는 처치마다 각각 어시스트를 받는다.
    room, (p1, p2, p3) = mk_room("검사", "궁수", "성직자")
    evs = []
    for nm in ("고블린 A", "고블린 B", "고블린 C"):
        evs.append({"kind": "defeated", "name": nm, "max_hp": 30,
                    "attackers": [p1, p2, p3], "killer": p1})
    out = room._distribute_kill_xp(evs)
    got = {}
    for e in out:
        got.setdefault((e["name"], e["kind"]), 0)
        got[(e["name"], e["kind"])] += 1
    assert got[(room.players[p1].name, "kill")] == 3, got
    assert got[(room.players[p2].name, "assist")] == 3, got
    assert got[(room.players[p3].name, "assist")] == 3, got
    # 누적 XP: p1 = 3*30 = 90, p2 = p3 = 3*10 = 30
    assert room.players[p1].xp == 90, room.players[p1].xp
    assert room.players[p2].xp == 30, room.players[p2].xp
    print("test_three_kills_one_turn_each_gives_assist OK")


def test_dot_death_uses_last_damager_not_last_actor():
    # DOT(디버프) 로 죽으면 그 턴 행동자가 없다 → 마지막 실제 데미지 딜러가 처치자.
    # attackers[-1](p3=힐러)이 아니라 last_damager_id(p2)가 killer 여야 한다.
    room, (p1, p2, p3) = mk_room("검사", "독술사", "힐러")
    main.parse_and_apply_monsters("[적 등장: 슬라임 | HP 30]", room.monsters, acting_player_id=None)
    sl = room.monsters["슬라임"]
    # p2 가 독을 걸어 실제 데미지 → last_damager_id=p2. 이후 p3(힐러)가 마지막에 행동만 함.
    main.parse_and_apply_monsters("[적 HP: 슬라임 30 → 6]", room.monsters, acting_player_id=p2)
    assert sl.last_damager_id == p2, sl.last_damager_id
    sl.note_attacker(p3)  # 힐러가 마지막에 행동 → attackers[-1]==p3
    sl.note_attacker(p1)  # p1 도 참여했었다고 가정하면 순서가 섞임 — 어쨌든 last_damager 우선
    assert sl.attackers[-1] != p2, sl.attackers
    # DOT: 강한 독으로 잔여 HP 소진 → tick_monsters_round 에서 defeated(killer=last_damager_id).
    sl.apply_status("디버프", "맹독", 3, "매 턴 -10 HP")
    evs = room.tick_monsters_round()
    defeated = [e for e in evs if e["kind"] == "defeated"]
    assert defeated and defeated[0]["killer"] == p2, defeated
    out = [e for e in evs if e.get("kind") in ("kill", "assist")]
    kinds = {e["name"]: e["kind"] for e in out}
    assert kinds[room.players[p2].name] == "kill", kinds
    print("test_dot_death_uses_last_damager_not_last_actor OK")


if __name__ == "__main__":
    test_all_actors_recorded_as_contributors()
    test_killer_is_turn_actor_not_last_attacker()
    test_assist_granted_via_full_parse_path()
    test_three_kills_one_turn_each_gives_assist()
    test_dot_death_uses_last_damager_not_last_actor()
    print("\nALL KILL-XP TESTS PASSED")
