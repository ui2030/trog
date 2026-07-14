"""[N-2] 장소별 배경 URL 캐시 자가검증 — 재사용/중복제거/상한30/폴백비캐시.
`python _test_explore_cache.py`. LLM 없이 generate_exploration_script 를 스텁으로 대체."""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import main  # noqa: E402


def _mk_room():
    room = main.GameRoom("TESTN2")
    room.started = True
    p = main.Player("p1", "테스터", "전사")
    room.attach_player(p)
    room.owner_id = "p1"
    return room


async def _launch(room, place, stages):
    async def _stub(place_, cells_, danger_):
        return {"terrain": "stone", "scene_stages": stages,
                "cells": [{"type": "empty"} for _ in range(cells_)]}
    orig = main.generate_exploration_script
    main.generate_exploration_script = _stub
    try:
        room.exploration = None
        room.exploration_pending = {"place": place, "cells": 5, "danger": "중", "starter_id": "p1"}
        return await room.maybe_launch_exploration()
    finally:
        main.generate_exploration_script = orig


def run():
    room = _mk_room()
    stages = ["a ruined gate", "a dark hall", "a deep vault"]

    # 1회차 — 캐시 미스: scene_stages 3장 그대로.
    p1 = asyncio.run(_launch(room, "성채 A", stages))
    assert len(p1["image_urls"]) == 3, p1["image_urls"]
    assert "성채 A" in room.explore_url_cache
    first = room.explore_url_cache["성채 A"]

    # 2회차 같은 장소 — 캐시 히트: 첫 장 재사용 + 새 시드 변주. 첫 URL 동일, 중복 없음.
    p2 = asyncio.run(_launch(room, "성채 A", stages))
    assert p2["image_urls"][0] == first[0], "첫 장 재사용 안 됨"
    assert len(p2["image_urls"]) == len(set(p2["image_urls"])), "중복 URL 존재"
    assert p2["image_urls"] != first, "재탐색인데 변주 0 (계속 생성 실패)"

    # 폴백 각본(stages 없음)은 캐시에 넣지 않는다.
    asyncio.run(_launch(room, "빈터 B", []))
    assert "빈터 B" not in room.explore_url_cache, "폴백 URL 이 캐시에 저장됨"

    # 빈 장소명은 캐시 오염 방지 — 저장/조회 안 함.
    asyncio.run(_launch(room, "", stages))
    assert "" not in room.explore_url_cache, "빈 장소명이 캐시에 저장됨"

    # 상한 30 — 32개 장소 넣으면 30 유지, 오래된 것부터 소멸.
    for i in range(32):
        asyncio.run(_launch(room, f"방{i}", stages))
    assert len(room.explore_url_cache) == 30, len(room.explore_url_cache)
    assert "방0" not in room.explore_url_cache and "방31" in room.explore_url_cache

    # to_save_dict 에 캐시가 새지 않는다(메모리 전용).
    assert "explore_url_cache" not in room.to_save_dict()

    print("N-2 EXPLORE CACHE TESTS PASSED")


if __name__ == "__main__":
    run()
