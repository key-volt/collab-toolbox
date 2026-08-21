"""Database engine.

One SQLite file, opened in-process. The pragmas below are applied to every connection:
WAL is not the default, foreign keys are off unless asked for, and the busy timeout is what
keeps a concurrent reader from failing outright while the single writer holds the lock.
"""

from pathlib import Path
from typing import Any

from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

PRAGMAS = (
    "PRAGMA journal_mode=WAL",
    "PRAGMA foreign_keys=ON",
    "PRAGMA busy_timeout=5000",
    "PRAGMA synchronous=NORMAL",
)


def apply_pragmas(connection: Any, _record: Any) -> None:
    cursor = connection.cursor()
    try:
        for pragma in PRAGMAS:
            cursor.execute(pragma)
    finally:
        cursor.close()


def create_engine(database_path: Path) -> AsyncEngine:
    engine = create_async_engine(f"sqlite+aiosqlite:///{database_path}")
    event.listen(engine.sync_engine, "connect", apply_pragmas)
    return engine


async def ping(engine: AsyncEngine) -> None:
    """Raise if the database cannot be opened and queried."""
    async with engine.connect() as connection:
        await connection.execute(text("SELECT 1"))
