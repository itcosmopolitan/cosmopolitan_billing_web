"""WebSocket endpoint for notification refresh hints."""
from __future__ import annotations

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from src.security import _decode_token
from src.notifications.hub import hub

router = APIRouter()


@router.websocket("/notifications")
async def notifications_socket(
    ws: WebSocket,
    token: str = Query(""),
):
    user_id = _decode_token(token) if token else None
    if not user_id:
        await ws.close(code=4401)
        return
    await hub.connect(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        hub.disconnect(ws)
