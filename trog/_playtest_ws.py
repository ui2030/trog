"""TROG WebSocket 사용자 시점 플레이테스트 — LLM 호출 없는 부분만 자동화 검증.

검증 항목:
- /scenarios HTTP API
- WS create_room → room_created
- WS join_room (다른 클라) → joined_room + 첫 클라엔 player_joined
- chat_message → entry.ts 동봉 확인 (V5-04)
- /portrait/{room}/{pid} 라우트 (V4 ⑲)
- 정적 파일 / index.html 의 maxlength=400 (V5-02)

게임 시작은 LLM 호출이 발생하므로 스킵 — wait/ready 단계까지만.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import urllib.request

# Windows 콘솔 cp949 회피 — 한국어/유니코드 메시지 print 안전.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import websockets

BASE = "http://127.0.0.1:8089"
WS = "ws://127.0.0.1:8089/ws"


async def _recv_until(ws, kinds: set[str], timeout: float = 5.0) -> dict:
    """원하는 type 이벤트 도착할 때까지 수신. 다른 이벤트는 무시(로깅만)."""
    end = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < end:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=end - asyncio.get_event_loop().time())
        except asyncio.TimeoutError:
            break
        msg = json.loads(raw)
        if msg.get("type") in kinds:
            return msg
        print(f"  [recv-ignored] {msg.get('type')}")
    raise TimeoutError(f"기대한 이벤트 {kinds} 미도착 (timeout {timeout}s)")


async def main():
    results: list[tuple[str, bool, str]] = []
    created_room_id: str | None = None

    def log(name: str, ok: bool, detail: str = ""):
        results.append((name, ok, detail))
        flag = "[OK]" if ok else "[FAIL]"
        print(f"{flag} {name} {('- ' + detail) if detail else ''}")

    # 1. HTTP /scenarios — 현재 응답: {"scenarios":[...], "default":id}
    try:
        with urllib.request.urlopen(f"{BASE}/scenarios", timeout=5) as r:
            data = json.loads(r.read())
        sc_list = data.get("scenarios") if isinstance(data, dict) else (data if isinstance(data, list) else None)
        ok = isinstance(sc_list, list) and len(sc_list) > 0
        log("HTTP /scenarios", ok,
            f"{len(sc_list) if isinstance(sc_list, list) else '?'} 시나리오")
    except Exception as e:
        log("HTTP /scenarios", False, str(e))

    # 2. 정적 index.html 에서 V5-02 maxlength 확인
    try:
        with urllib.request.urlopen(f"{BASE}/static/index.html", timeout=5) as r:
            html = r.read().decode("utf-8")
        ok = 'id="action-input"' in html and 'maxlength="400"' in html
        log("V5-02 action-input maxlength=400", ok,
            "index.html 정상" if ok else "maxlength 미반영 또는 marker 누락")
    except Exception as e:
        log("V5-02 action-input maxlength=400", False, str(e))

    # 3. game.js V5-01/03/04/05 marker 검증
    try:
        with urllib.request.urlopen(f"{BASE}/static/game.js", timeout=5) as r:
            js = r.read().decode("utf-8")
        markers = {
            "V5-01 copyBound": "drcEl.dataset.copyBound" in js,
            "V5-03 _dmTypingTimer": "_dmTypingTimer" in js and "_dmTypingStartedAt" in js,
            "V5-04 _fmtChatTs": "_fmtChatTs" in js,
            "V5-05 hud-dead": "hud-dead" in js and "hud-critical" in js,
            "V6-01 isComposing": "isComposing" in js and "keyCode !== 229" in js,
            "V6-02 _capNarrLog": "_capNarrLog" in js and "_NARR_LOG_CAP" in js,
            "V6-04 ws.onclose dm-typing": "ws.onclose = () => {" in js
                and "showDmTyping(false)" in js,
            "V6-05 DRAW_AUTOSAVE": "DRAW_AUTOSAVE_KEY" in js,
            "V6-07 _setActionBarBusy": "_setActionBarBusy" in js,
            "V48/V55 cleanup helper": "function cleanupTransientUiState" in js
                and "cleanupTransientUiState('dm_response')" in js
                and "cleanupTransientUiState(`error:${d.code || 'unknown'}`)" in js,
            "V49/V54 heartbeat restart": "if (_heartbeatTimer) clearInterval(_heartbeatTimer)" in js
                and "scheduleReconnect before detach" in js,
            "V50-01 entry help button": "entry-help-btn" in js and "_showHelpModal" in js,
            "V51/V52 session_replaced handler": "case 'session_replaced'" in js
                and "location.href = location.pathname" in js,
        }
        for name, ok in markers.items():
            log(name, ok)
    except Exception as e:
        log("static/game.js fetch", False, str(e))

    # 4. WS create_room (1번 클라)
    async with websockets.connect(WS) as ws_owner:
        await ws_owner.send(json.dumps({
            "type": "create_room",
            "player_name": "테스터1",
            "character_class": "전사",
            "weapon_choice": "녹슨 장검",
            "scenario_id": "lost_blade",
        }))
        try:
            msg = await _recv_until(ws_owner, {"room_created"}, timeout=8)
            room_id = msg.get("room_id") or msg.get("room", {}).get("room_id")
            created_room_id = room_id
            owner_pid = msg.get("player_id") or (msg.get("you", {}) if isinstance(msg.get("you"), dict) else {}).get("player_id")
            log("WS create_room", bool(room_id and owner_pid),
                f"room={room_id} owner_pid={owner_pid}")
        except Exception as e:
            log("WS create_room", False, str(e))
            print(json.dumps(msg if 'msg' in locals() else {}, ensure_ascii=False, indent=2)[:600])
            return

        # 5. WS 두 번째 클라이언트 join
        async with websockets.connect(WS) as ws_b:
            await ws_b.send(json.dumps({
                "type": "join_room",
                "room_id": room_id,
                "player_name": "테스터2",
                "character_class": "도적",
                "weapon_choice": "쌍단검",
            }))
            try:
                jm = await _recv_until(ws_b, {"joined_room"}, timeout=8)
                log("WS join_room (클라B)",
                    jm.get("room_id") == room_id and bool(jm.get("player_id")),
                    f"player_id={jm.get('player_id')}")
                b_pid = jm.get("player_id")
            except Exception as e:
                log("WS join_room (클라B)", False, str(e))
                return

            # owner 쪽엔 player_joined 도착해야 함
            try:
                pj = await _recv_until(ws_owner, {"player_joined"}, timeout=5)
                log("브로드캐스트 player_joined", bool(pj.get("player")),
                    pj.get("player", {}).get("name", "?"))
            except Exception as e:
                log("브로드캐스트 player_joined", False, str(e))

            # 6. chat_message (테스터1 → 모두)
            await ws_owner.send(json.dumps({"type": "chat_message", "text": "안녕하세요"}))
            try:
                cb = await _recv_until(ws_b, {"chat_broadcast"}, timeout=5)
                entry = cb.get("entry") or {}
                ok_ts = isinstance(entry.get("ts"), (int, float)) and entry["ts"] > 0
                ok_text = entry.get("text") == "안녕하세요"
                log("V5-04 chat_message ts 동봉", ok_ts and ok_text,
                    f"ts={entry.get('ts')} text={entry.get('text')!r}")
            except Exception as e:
                log("V5-04 chat_message ts 동봉", False, str(e))

            # 7. /portrait route (V4 (R)) — GET 으로 검사. FastAPI 기본은 HEAD 미허용(405).
            try:
                pu = f"{BASE}/portrait/{room_id}/{owner_pid}"
                # 커스텀 그림 없으면 302 → Pollinations 로 redirect 됨. follow 막아 외부 호출 회피.
                class _NoFollow(urllib.request.HTTPRedirectHandler):
                    def redirect_request(self, *a, **kw):
                        return None
                opener = urllib.request.build_opener(_NoFollow())
                req = urllib.request.Request(pu, method="GET")
                try:
                    with opener.open(req, timeout=5) as r:
                        code = r.status
                except urllib.error.HTTPError as he:
                    code = he.code
                ok = code in (200, 301, 302, 303, 307, 308)
                log("V4 portrait route", ok, f"HTTP {code}")
            except Exception as e:
                log("V4 portrait route", False, str(e))

        # 8. V51/V52: 같은 player_id 로 rejoin 하면 기존 세션은 session_replaced 를 받고 종료되어야 함.
        async with websockets.connect(WS) as ws_rejoin:
            await ws_rejoin.send(json.dumps({
                "type": "rejoin_room",
                "room_id": room_id,
                "player_id": owner_pid,
            }))
            try:
                old_msg = await _recv_until(ws_owner, {"session_replaced"}, timeout=5)
                new_msg = await _recv_until(ws_rejoin, {"rejoin_ok"}, timeout=5)
                log("V51/V52 session_replaced 실제 WS", old_msg.get("type") == "session_replaced"
                    and new_msg.get("player_id") == owner_pid,
                    f"new={new_msg.get('type')} old={old_msg.get('type')}")
            except Exception as e:
                log("V51/V52 session_replaced 실제 WS", False, str(e))

    # 테스트가 만든 save 파일은 회귀 테스트 산출물이므로 websocket 종료 후 정리.
    # (종료 finally 가 save_room 을 다시 찍을 수 있어서 with block 내부에서 지우면 부활한다.)
    if created_room_id:
        save_path = os.path.join(os.path.dirname(__file__), "saves", f"{created_room_id}.json")
        for attempt in range(6):
            try:
                os.remove(save_path)
            except FileNotFoundError:
                break
            except Exception as e:
                if attempt == 5:
                    print(f"  [cleanup-warn] save cleanup failed: {e}")
            await asyncio.sleep(0.15)

    # 9. 서버 코드 정적 회귀: error code + process_action lock split.
    try:
        with open(os.path.join(os.path.dirname(__file__), "main.py"), "r", encoding="utf-8") as f:
            py = f.read()
        log("V53/V55 structured error code", '"code": "dm_action_failed"' in py
            and '"code": "dm_intro_timeout"' in py
            and 'dm_intro_failed' in py
            and 'async def _send_error(ws: WebSocket, message: str, code: str = "generic_error")' in py)
        pa = py[py.index("async def process_action"):py.index("async def process_monster_turn")]
        lock_head = pa.index("async with self.lock:")
        llm_pos = pa.index("text = await llm_complete")
        final_lock = pa.rindex("async with self.lock:")
        log("V55 process_action LLM outside lock", lock_head < llm_pos < final_lock
            and "llm_messages = self._llm_slice()" in pa
            and "self.messages = [m for m in self.messages if m is not user_msg]" in pa)
        lock_stack: list[int] = []
        llm_inside_lock = False
        for line in py.splitlines():
            stripped = line.lstrip()
            indent = len(line) - len(stripped)
            while lock_stack and indent <= lock_stack[-1]:
                lock_stack.pop()
            if stripped.startswith(("async with self.lock:", "async with room.lock:")):
                lock_stack.append(indent)
            if "await llm_complete" in stripped and lock_stack:
                llm_inside_lock = True
                break
        log("V55 no llm_complete inside room locks", not llm_inside_lock)
    except Exception as e:
        log("V55 static regression scan", False, str(e))

    # 결과 요약
    print("\n" + "=" * 60)
    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    print(f"플레이테스트 결과: {passed}/{total} 통과")
    failed = [r for r in results if not r[1]]
    if failed:
        print("\n실패 항목:")
        for n, _, d in failed:
            print(f"  - {n}: {d}")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
