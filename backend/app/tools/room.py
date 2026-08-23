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
from pycrdt import Channel, YMessageType, YSyncMessageType
from pycrdt.websocket import WebsocketServer
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette.websockets import WebSocketDisconnect

from app.auth.access import AccessLevel, access_level, satisfies
from app.auth.tokens import TokenError, read_access_token
from app.models import Document, User

logger = logging.getLogger(__name__)

SUBPROTOCOL = "collab.v1"
BEARER_PREFIX = "bearer."

CLOSE_UNAUTHORIZED = 4401
CLOSE_FORBIDDEN = 4403
CLOSE_NOT_FOUND = 4404


def _write_allowed_for_reader(message: bytes) -> bool:
    """Whether a frame from a read-only connection may reach the room.

    Awareness (presence, cursors) passes; so does sync step 1, which only asks the
    server for state. Sync step 2 and updates would write into the shared document,
    so they are dropped — read access is enforced here, not trusted to the client.
    The type bytes are single-byte varuints for every value involved.
    """
    if len(message) == 0:
        return False
    if message[0] == YMessageType.AWARENESS:
        return True
    if message[0] == YMessageType.SYNC and len(message) > 1:
        return message[1] == YSyncMessageType.SYNC_STEP1
    return False


class StarletteWebsocket(Channel):
    """Adapts a Starlette websocket to the channel the room server drives.

    Shaped after the adapter the library itself ships: sends are serialized behind a
    lock because a room broadcasts to many clients concurrently, and any receive error
    simply ends the iteration — the handler's cleanup does the rest. A read-only
    connection never yields a document write to the room.
    """

    def __init__(self, websocket: WebSocket, path: str, read_only: bool = False) -> None:
        self._websocket = websocket
        self._path = path
        self._read_only = read_only
        self._send_lock = Lock()

    @property
    def path(self) -> str:
        return self._path

    async def __anext__(self) -> bytes:
        try:
            while True:
                message = await self.recv()
                if not self._read_only or _write_allowed_for_reader(message):
                    return message
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
    """The room server plus a live registry of who holds which socket on which document.

    The registry exists so that revoking access — to one document or to the whole
    account — closes the affected open editors immediately instead of when a token
    happens to expire.
    """

    def __init__(self) -> None:
        self.server = WebsocketServer(
            auto_clean_rooms=True, exception_handler=_handle_room_exception
        )
        self._connections: dict[WebSocket, tuple[str, str]] = {}

    def register(self, user_id: str, doc_id: str, websocket: WebSocket) -> None:
        self._connections[websocket] = (user_id, doc_id)

    def unregister(self, websocket: WebSocket) -> None:
        self._connections.pop(websocket, None)

    async def _close(self, websocket: WebSocket) -> None:
        # A socket already closing raises; its registry entry goes away with its handler.
        with contextlib.suppress(RuntimeError):
            await websocket.close(code=CLOSE_FORBIDDEN)

    async def kick_user(self, user_id: str) -> None:
        for websocket, (held_user, _doc) in list(self._connections.items()):
            if held_user == user_id:
                await self._close(websocket)

    async def kick_user_from_document(self, user_id: str, doc_id: str) -> None:
        for websocket, held in list(self._connections.items()):
            if held == (user_id, doc_id):
                await self._close(websocket)

    async def kick_document(self, doc_id: str) -> None:
        for websocket, (_user, held_doc) in list(self._connections.items()):
            if held_doc == doc_id:
                await self._close(websocket)


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
        level: AccessLevel = "none"
        if user is not None and document is not None:
            level = await access_level(session, user, document)
    if user is None or not user.is_whitelisted:
        await websocket.close(code=CLOSE_FORBIDDEN)
        return
    if document is None or document.tool != tool:
        await websocket.close(code=CLOSE_NOT_FOUND)
        return
    if not satisfies(level, "read"):
        await websocket.close(code=CLOSE_FORBIDDEN)
        return

    await websocket.accept(subprotocol=SUBPROTOCOL)
    hub: RoomHub = state.hub
    hub.register(user_id, doc_id, websocket)
    try:
        channel = StarletteWebsocket(
            websocket, f"{tool}/{doc_id}", read_only=not satisfies(level, "edit")
        )
        await hub.server.serve(channel)
    except WebSocketDisconnect:
        pass
    finally:
        hub.unregister(websocket)
