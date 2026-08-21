"""Deleted documents.

Deletion moves the folder into the trash together with a manifest of its database rows,
so a restore can put both the files and the rows back. After the retention window the
folder — and the uploads its manifest names — are purged for good.
"""

import json
import re
import shutil
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from app.config import Settings
from app.storage.docs import document_dir

MANIFEST = ".manifest.json"

_TRASH_NAME = re.compile(r"^(?P<stamp>\d{8}T\d{6}Z)-(?P<dir_name>.+)$")


@dataclass(frozen=True)
class TrashEntry:
    name: str
    title: str
    tool: str
    deleted_at: str
    purge_after: str


def _timestamp() -> str:
    return datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")


def move_to_trash(
    settings: Settings,
    dir_name: str,
    document: dict[str, Any],
    pages: list[dict[str, Any]],
    uploads: list[dict[str, Any]],
) -> str:
    directory = document_dir(settings, dir_name)
    manifest = {
        "deleted_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "document": document,
        "pages": pages,
        "uploads": uploads,
    }
    (directory / MANIFEST).write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    name = f"{_timestamp()}-{dir_name}"
    settings.trash_dir.mkdir(parents=True, exist_ok=True)
    shutil.move(str(directory), str(settings.trash_dir / name))
    return name


def _read_manifest(path: Path) -> dict[str, Any] | None:
    try:
        loaded = json.loads((path / MANIFEST).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(loaded, dict):
        return None
    return loaded


def list_trash(settings: Settings, trash_days: int) -> list[TrashEntry]:
    if not settings.trash_dir.is_dir():
        return []
    entries = []
    for path in settings.trash_dir.iterdir():
        parsed = _TRASH_NAME.match(path.name)
        manifest = _read_manifest(path) if path.is_dir() else None
        if parsed is None or manifest is None:
            continue
        document = manifest.get("document", {})
        deleted_at = str(manifest.get("deleted_at", ""))
        deleted = datetime.strptime(parsed.group("stamp"), "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)
        purge_after = (deleted + timedelta(days=trash_days)).strftime("%Y-%m-%dT%H:%M:%SZ")
        entries.append(
            TrashEntry(
                name=path.name,
                title=str(document.get("title", path.name)),
                tool=str(document.get("tool", "")),
                deleted_at=deleted_at,
                purge_after=purge_after,
            )
        )
    return sorted(entries, key=lambda entry: entry.name, reverse=True)


def restore_from_trash(settings: Settings, name: str) -> dict[str, Any] | None:
    """Move a trashed folder back into place and return its manifest, or None."""
    if _TRASH_NAME.match(name) is None:
        return None
    source = settings.trash_dir / name
    manifest = _read_manifest(source) if source.is_dir() else None
    if manifest is None:
        return None
    document = manifest.get("document", {})
    dir_name = str(document.get("dir_name", ""))
    if not dir_name:
        return None
    target = document_dir(settings, dir_name)
    if target.exists():
        return None
    shutil.move(str(source), str(target))
    (target / MANIFEST).unlink(missing_ok=True)
    return manifest


def purge_expired(settings: Settings, trash_days: int) -> int:
    """Remove trash folders past retention, and the upload files they reference."""
    if not settings.trash_dir.is_dir():
        return 0
    cutoff = (datetime.now(UTC) - timedelta(days=trash_days)).strftime("%Y%m%dT%H%M%SZ")
    purged = 0
    for path in settings.trash_dir.iterdir():
        parsed = _TRASH_NAME.match(path.name)
        if parsed is None or not path.is_dir() or parsed.group("stamp") >= cutoff:
            continue
        manifest = _read_manifest(path) or {}
        for upload in manifest.get("uploads", []):
            upload_id = str(upload.get("id", ""))
            if upload_id:
                (settings.uploads_dir / upload_id).unlink(missing_ok=True)
        shutil.rmtree(path, ignore_errors=True)
        purged += 1
    return purged
