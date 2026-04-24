"""Windows launcher — forces ProactorEventLoop so subprocess works."""
import asyncio
import sys

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

import uvicorn


def main() -> None:
    config = uvicorn.Config(
        "src.main:app",
        host="0.0.0.0",
        port=8000,
        loop="none",
        reload=False,
    )
    server = uvicorn.Server(config)
    asyncio.run(server.serve())


if __name__ == "__main__":
    main()
