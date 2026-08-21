"""Liveness endpoint.

Deliberately anonymous and deliberately dull. It answers one question — can this process
reach its own storage — and reveals nothing else: no version, no build identifier, no counts.
"""

import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncEngine

from app.db import ping

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/health")
async def health(request: Request) -> JSONResponse:
    engine: AsyncEngine = request.app.state.engine
    try:
        await ping(engine)
    except (SQLAlchemyError, OSError) as exc:
        logger.warning("health check failed: %s", type(exc).__name__)
        return JSONResponse({"status": "unavailable"}, status_code=503)
    return JSONResponse({"status": "ok"})
