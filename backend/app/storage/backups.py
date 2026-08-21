"""Periodic database backups.

A live WAL-mode SQLite file must not be copied byte for byte, so backups are written with
VACUUM INTO, which is atomic against a running database. Each family of backup files is
pruned to the retention count separately, so boot-time copies cannot crowd out the
periodic ones or the other way round.
"""

import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

PERIODIC_PREFIX = "app-"
PRE_MIGRATE_PREFIX = "pre-migrate-"


def _timestamp() -> str:
    return datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")


def _family(backups_dir: Path, prefix: str) -> list[Path]:
    if not backups_dir.is_dir():
        return []
    found = [
        entry
        for entry in backups_dir.iterdir()
        if entry.is_file() and entry.name.startswith(prefix) and entry.suffix == ".sqlite"
    ]
    return sorted(found, key=lambda path: path.name, reverse=True)


def write_backup(database_path: Path, backups_dir: Path, keep: int) -> Path:
    backups_dir.mkdir(parents=True, exist_ok=True)
    target = backups_dir / f"{PERIODIC_PREFIX}{_timestamp()}.sqlite"
    connection = sqlite3.connect(database_path)
    try:
        connection.execute("VACUUM INTO ?", (str(target),))
    finally:
        connection.close()
    prune_backups(backups_dir, keep)
    return target


def backup_due(backups_dir: Path, interval_hours: int) -> bool:
    newest = _family(backups_dir, PERIODIC_PREFIX)
    if not newest:
        return True
    stamp = newest[0].name.removeprefix(PERIODIC_PREFIX).removesuffix(".sqlite")
    try:
        written = datetime.strptime(stamp, "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)
    except ValueError:
        return True
    return datetime.now(UTC) - written >= timedelta(hours=interval_hours)


def prune_backups(backups_dir: Path, keep: int) -> None:
    for prefix in (PERIODIC_PREFIX, PRE_MIGRATE_PREFIX):
        for path in _family(backups_dir, prefix)[keep:]:
            path.unlink(missing_ok=True)
