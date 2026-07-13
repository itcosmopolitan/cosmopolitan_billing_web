"""WebSocket hub — push refresh hints when notifications change (Phase 6e)."""
from __future__ import annotations

from fastapi import WebSocket


class NotificationHub:
    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._clients.add(ws)

    def disconnect(self, ws: WebSocket) -> None:
        self._clients.discard(ws)

    async def broadcast_refresh(self) -> None:
        dead: list[WebSocket] = []
        for ws in self._clients:
            try:
                await ws.send_json({"type": "refresh"})
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._clients.discard(ws)


hub = NotificationHub()
