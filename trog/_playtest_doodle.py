"""[L] 공동 낙서판 2-클라 실동 검증 — _playtest_ws.py 패턴, LLM 무관.
A(방장) 그린 획 → B 수신, C 새 합류 → doodle_state 복원, 방장 아닌 B clear 거부 / 방장 A clear 브로드캐스트."""
from __future__ import annotations

import asyncio
import json
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import websockets

PORT = os.getenv("GAME_PORT", "8099")
WS = f"ws://127.0.0.1:{PORT}/ws"


async def _recv_until(ws, kinds, timeout=5.0):
    loop = asyncio.get_event_loop()
    end = loop.time() + timeout
    while loop.time() < end:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=end - loop.time())
        except asyncio.TimeoutError:
            break
        m = json.loads(raw)
        if m.get("type") in kinds:
            return m
    raise TimeoutError(f"기대 이벤트 {kinds} 미도착")


async def _expect_silence(ws, kinds, timeout=1.2):
    """timeout 안에 kinds 이벤트가 오지 않아야 통과."""
    loop = asyncio.get_event_loop()
    end = loop.time() + timeout
    while loop.time() < end:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=end - loop.time())
        except asyncio.TimeoutError:
            return True
        if json.loads(raw).get("type") in kinds:
            return False
    return True


async def main():
    results = []

    def log(name, ok, detail=""):
        results.append(ok)
        print(f"{'[OK]' if ok else '[FAIL]'} {name} {('- ' + detail) if detail else ''}")

    room_id = None
    async with websockets.connect(WS) as a:
        await a.send(json.dumps({"type": "create_room", "player_name": "앨리스",
                                 "character_class": "전사", "weapon_choice": "녹슨 장검"}))
        m = await _recv_until(a, {"room_created"}, timeout=8)
        room_id = m["room_id"]
        log("A create_room", bool(room_id), f"room={room_id}")

        async with websockets.connect(WS) as b:
            await b.send(json.dumps({"type": "join_room", "room_id": room_id,
                                     "player_name": "밥", "character_class": "도적", "weapon_choice": "쌍단검"}))
            await _recv_until(b, {"joined_room"}, timeout=8)
            # A 가 획을 그림 → B 가 doodle_stroke 수신
            stroke = {"type": "doodle_stroke", "color": "#e23c3c", "w": 8,
                      "pts": [[0.1, 0.1], [0.5, 0.5], [0.9, 0.2]]}
            await a.send(json.dumps(stroke))
            got = await _recv_until(b, {"doodle_stroke"}, timeout=5)
            ok = (got.get("stroke", {}).get("color") == "#e23c3c"
                  and len(got["stroke"]["pts"]) == 3)
            log("A 획 → B 수신", ok, f"pts={got.get('stroke', {}).get('pts')}")

            # A 는 자기 획을 echo 받지 않아야 (exclude=sender)
            log("A 자기 획 echo 없음", await _expect_silence(a, {"doodle_stroke"}, 1.0))

            # 잘못된 획(색 밖) → 아무도 못 받음
            await a.send(json.dumps({"type": "doodle_stroke", "color": "#ff00ff", "w": 3,
                                     "pts": [[0.1, 0.1], [0.2, 0.2]]}))
            log("검증 실패 획 drop", await _expect_silence(b, {"doodle_stroke"}, 1.0))

            # C 새 합류 → doodle_state 복원 (기존 1획)
            async with websockets.connect(WS) as c:
                await c.send(json.dumps({"type": "join_room", "room_id": room_id,
                                         "player_name": "찰리", "character_class": "마법사", "weapon_choice": "낡은 지팡이"}))
                # joined_room 과 doodle_state 둘 다 오는데 순서 무관하게 doodle_state 를 기다림
                st = await _recv_until(c, {"doodle_state"}, timeout=5)
                ok = isinstance(st.get("strokes"), list) and len(st["strokes"]) == 1
                log("C 합류 doodle_state 복원", ok, f"strokes={len(st.get('strokes', []))}")

            # 방장 아닌 B 가 clear → error, doodle 유지
            await b.send(json.dumps({"type": "doodle_clear"}))
            err = await _recv_until(b, {"error"}, timeout=3)
            log("비방장 clear 거부", "방장" in err.get("message", ""), err.get("message"))
            # 그 사이 clear 브로드캐스트가 오지 않았어야
            log("비방장 clear 미적용", await _expect_silence(a, {"doodle_clear"}, 1.0))

            # 방장 A 가 clear → B 에 doodle_clear 브로드캐스트
            await a.send(json.dumps({"type": "doodle_clear"}))
            cl = await _recv_until(b, {"doodle_clear"}, timeout=3)
            log("방장 clear 브로드캐스트", cl.get("type") == "doodle_clear")

    print("\n" + ("✅ 낙서판 실동 전부 통과" if all(results) else "❌ 실패 있음"))
    print(f"ROOM_ID={room_id}")   # 스크립트 호출측이 saves 정리에 사용
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    asyncio.run(main())
