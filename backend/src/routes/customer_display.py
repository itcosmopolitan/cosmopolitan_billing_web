"""
Live customer display — WebSocket relay between cashier and customer screens.

No REST persistence: the latest cart snapshot is held in memory per room and
broadcast to all connected viewer clients when the cashier sends an update.
"""
from __future__ import annotations

import json
from typing import Literal

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter()

Role = Literal["cashier", "viewer"]


class _Room:
    __slots__ = ("state", "cashiers", "viewers")

    def __init__(self) -> None:
        self.state: dict | None = None
        self.cashiers: set[WebSocket] = set()
        self.viewers: set[WebSocket] = set()


class DisplayHub:
    """In-memory room registry. Use Redis pub/sub if you scale to multiple workers."""

    def __init__(self) -> None:
        self._rooms: dict[str, _Room] = {}

    def _room(self, room_id: str) -> _Room:
        if room_id not in self._rooms:
            self._rooms[room_id] = _Room()
        return self._rooms[room_id]

    async def connect(self, room_id: str, role: Role, ws: WebSocket) -> None:
        await ws.accept()
        room = self._room(room_id)
        if role == "cashier":
            room.cashiers.add(ws)
        else:
            room.viewers.add(ws)
            if room.state is not None:
                await ws.send_json({"type": "cart_update", "payload": room.state})

    def disconnect(self, room_id: str, role: Role, ws: WebSocket) -> None:
        room = self._rooms.get(room_id)
        if not room:
            return
        bucket = room.cashiers if role == "cashier" else room.viewers
        bucket.discard(ws)
        if not room.cashiers and not room.viewers:
            self._rooms.pop(room_id, None)

    async def handle_cashier_message(self, room_id: str, ws: WebSocket, raw: str) -> None:
        room = self._room(room_id)
        if ws not in room.cashiers:
            await ws.send_json({"type": "error", "message": "Not registered as cashier"})
            return
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            await ws.send_json({"type": "error", "message": "Invalid JSON"})
            return
        if msg.get("type") != "cart_update":
            await ws.send_json({"type": "error", "message": "Unknown message type"})
            return
        payload = msg.get("payload")
        if not isinstance(payload, dict):
            await ws.send_json({"type": "error", "message": "payload must be an object"})
            return
        room.state = payload
        envelope = {"type": "cart_update", "payload": payload}
        dead: list[WebSocket] = []
        for viewer in room.viewers:
            try:
                await viewer.send_json(envelope)
            except Exception:
                dead.append(viewer)
        for dead_ws in dead:
            room.viewers.discard(dead_ws)


hub = DisplayHub()


@router.websocket("/display/{room_id}")
async def display_socket(ws: WebSocket, room_id: str, role: Role = "viewer"):
    """Connect with ?role=cashier (sender) or ?role=viewer (customer screen)."""
    room_id = (room_id or "default").strip() or "default"
    if role not in ("cashier", "viewer"):
        role = "viewer"
    await hub.connect(room_id, role, ws)
    try:
        if role == "cashier":
            while True:
                await hub.handle_cashier_message(room_id, ws, await ws.receive_text())
        else:
            while True:
                # Viewers listen only; keep connection alive.
                await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        hub.disconnect(room_id, role, ws)
