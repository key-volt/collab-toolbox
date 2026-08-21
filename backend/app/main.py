"""Application factory.

The interactive API documentation is switched off: this runs on a public domain and the
schema would be readable without a session.
"""

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI

from app.api import admin, auth, documents, files, health, tools
from app.auth.ratelimit import SlidingWindowLimiter
from app.config import get_settings
from app.db import create_engine, create_session_factory
from app.storage.maintenance import maintenance_loop
from app.tools.room import RoomHub, serve_document_room


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    engine = create_engine(settings.database_path)
    app.state.engine = engine
    app.state.sessions = create_session_factory(engine)
    # Read once per boot: the signing key must be stable across a process lifetime, and a
    # missing file should stop the server here rather than on the first login.
    app.state.jwt_secret = settings.read_secret("jwt_secret")
    app.state.hub = RoomHub()
    app.state.login_limiter_by_username = SlidingWindowLimiter(10, 60)
    app.state.login_limiter_by_ip = SlidingWindowLimiter(30, 60)
    maintenance = asyncio.create_task(maintenance_loop(app))
    try:
        async with app.state.hub.server:
            yield
    finally:
        maintenance.cancel()
        with suppress(asyncio.CancelledError):
            await maintenance
        await engine.dispose()


def create_app() -> FastAPI:
    app = FastAPI(
        title="collab-toolbox",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    for router in (
        health.router,
        auth.router,
        admin.router,
        documents.router,
        files.router,
        tools.router,
    ):
        app.include_router(router, prefix="/api")
    app.add_api_websocket_route("/ws/{tool}/{doc_id}", serve_document_room)
    return app


app = create_app()
