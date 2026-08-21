"""Steps that run before the server is allowed to accept traffic.

Anything raising here stops the container instead of letting it serve a data directory or a
database it could not prepare.
"""

import sqlite3
import sys
from datetime import UTC, datetime
from pathlib import Path

from app.config import Settings, get_settings
from app.db import PRAGMAS


def timestamp() -> str:
    return datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")


def ensure_layout(settings: Settings) -> None:
    for directory in (
        settings.data_dir,
        settings.docs_dir,
        settings.trash_dir,
        settings.uploads_dir,
        settings.backups_dir,
    ):
        directory.mkdir(parents=True, exist_ok=True)


def backup_database(database_path: Path, backups_dir: Path) -> Path | None:
    """Take a copy of the database before the schema is touched.

    VACUUM INTO is atomic against a running database; copying a WAL-mode file byte for byte
    is not. Returns None when there is no database yet.
    """
    if not database_path.exists() or database_path.stat().st_size == 0:
        return None
    target = backups_dir / f"pre-migrate-{timestamp()}.sqlite"
    connection = sqlite3.connect(database_path)
    try:
        connection.execute("VACUUM INTO ?", (str(target),))
    finally:
        connection.close()
    return target


def initialise_database(database_path: Path) -> None:
    """Create the file if it is missing and persist the pragmas that are stored in it."""
    connection = sqlite3.connect(database_path)
    try:
        for pragma in PRAGMAS:
            connection.execute(pragma)
    finally:
        connection.close()


def main() -> int:
    settings = get_settings()
    ensure_layout(settings)
    copy = backup_database(settings.database_path, settings.backups_dir)
    if copy is not None:
        print(f"boot: database copied to {copy.name}", file=sys.stderr)
    initialise_database(settings.database_path)
    print("boot: data directory and database ready", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
