"""The shared document room.

Both tools bind their editors to a Yjs document; this is the transport those documents
share. The server relays opaque updates between clients and holds room state in memory
only — it never reads document content, and a restart clears every room.

Authentication happens during the websocket handshake: the token travels in the
Sec-WebSocket-Protocol header, never a query string, and authorization is read from the
database at connect time rather than trusted from the token.
"""

import contextlib
import logging

from anyio import Lock
from fastapi import WebSocket
from pycrdt import Channel
from pycrdt.websocket import WebsocketServer
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette.websockets import WebSocketDisconnect

from app.auth.tokens import TokenError, read_access_token
from app.models import Document, User

logger = logging.getLogger(__name__)

SUBPROTOCOL = "collab.v1"
BEARER_PREFIX = "bearer."

CLOSE_UNAUTHORIZED = 4401
CLOSE_FORBIDDEN = 4403
CLOSE_NOT_FOUND = 4404


class StarletteWebsocket(Channel):
    """Adapts a Starlette websocket to the channel the room server drives.

    Shaped after the adapter the library itself ships: sends are serialized behind a
    lock because a room broadcasts to many clients concurrently, and any receive error
    simply ends the iteration — the handler's cleanup does the rest.
    """

    def __init__(self, websocket: WebSocket, path: str) -> None:
        self._websocket = websocket
        self._path = path
        self._send_lock = Lock()

    @property
    def path(self) -> str:
        return self._path

    async def __anext__(self) -> bytes:
        try:
            return await self.recv()
        except Exception:
            raise StopAsyncIteration from None

    async def send(self, message: bytes) -> None:
        async with self._send_lock:
            await self._websocket.send_bytes(message)

    async def recv(self) -> bytes:
        return bytes(await self._websocket.receive_bytes())


def _handle_room_exception(exception: Exception, log: logging.Logger) -> bool:
    if isinstance(exception, WebSocketDisconnect):
        return True
    log.warning("room error: %s: %s", type(exception).__name__, exception)
    return True


class RoomHub:
    """The room server plus a live registry of who holds which socket.

    The registry exists so that revoking a user closes their open editors immediately
    instead of when their token happens to expire.
    """

    def __init__(self) -> None:
        self.server = WebsocketServer(
            auto_clean_rooms=True, exception_handler=_handle_room_exception
        )
        self._sockets: dict[str, set[WebSocket]] = {}

    def register(self, user_id: str, websocket: WebSocket) -> None:
        self._sockets.setdefault(user_id, set()).add(websocket)

    def unregister(self, user_id: str, websocket: WebSocket) -> None:
        sockets = self._sockets.get(user_id)
        if sockets is None:
            return
        sockets.discard(websocket)
        if not sockets:
            del self._sockets[user_id]

    async def kick_user(self, user_id: str) -> None:
        for websocket in list(self._sockets.get(user_id, ())):
            # A socket already closing raises; its registry entry goes away with its handler.
            with contextlib.suppress(RuntimeError):
                await websocket.close(code=CLOSE_FORBIDDEN)


def _bearer_token(header: str) -> tuple[bool, str | None]:
    """Split the offered subprotocols into (protocol offered, token)."""
    offered = [part.strip() for part in header.split(",") if part.strip()]
    token = None
    for part in offered:
        if part.startswith(BEARER_PREFIX):
            token = part.removeprefix(BEARER_PREFIX)
            break
    return SUBPROTOCOL in offered, token


async def serve_document_room(websocket: WebSocket, tool: str, doc_id: str) -> None:
    state = websocket.app.state
    protocol_offered, token = _bearer_token(websocket.headers.get("sec-websocket-protocol", ""))
    if not protocol_offered or token is None:
        await websocket.close(code=CLOSE_UNAUTHORIZED)
        return
    try:
        user_id = read_access_token(token, state.jwt_secret)
    except TokenError:
        await websocket.close(code=CLOSE_UNAUTHORIZED)
        return

    factory: async_sessionmaker[AsyncSession] = state.sessions
    async with factory() as session:
        user = await session.get(User, user_id)
        document = await session.get(Document, doc_id)
    if user is None or not user.is_whitelisted:
        await websocket.close(code=CLOSE_FORBIDDEN)
        return
    if document is None or document.tool != tool:
        await websocket.close(code=CLOSE_NOT_FOUND)
        return

    await websocket.accept(subprotocol=SUBPROTOCOL)
    hub: RoomHub = state.hub
    hub.register(user_id, websocket)
    try:
        await hub.server.serve(StarletteWebsocket(websocket, f"{tool}/{doc_id}"))
    except WebSocketDisconnect:
        pass
    finally:
        hub.unregister(user_id, websocket)
