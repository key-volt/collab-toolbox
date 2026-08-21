"""Document folders on disk.

Every function here is synchronous; request handlers call them through a worker thread so
the event loop never blocks on the filesystem.
"""

import re
from datetime import UTC, datetime
from pathlib import Path

from app.config import Settings

_SLUG_PATTERN = re.compile(r"[^a-z0-9]+")


def dir_name_for(title: str, document_id: str) -> str:
    """A filesystem name that stays readable and cannot collide: slug plus id prefix."""
    slug = _SLUG_PATTERN.sub("-", title.lower()).strip("-")[:40] or "doc"
    return f"{slug}-{document_id[:8]}"


def document_dir(settings: Settings, dir_name: str) -> Path:
    return settings.docs_dir / dir_name


def create_document_dir(settings: Settings, dir_name: str, files: dict[str, bytes]) -> None:
    directory = document_dir(settings, dir_name)
    directory.mkdir(parents=True)
    for filename, content in files.items():
        (directory / filename).write_bytes(content)


def modified_at(settings: Settings, dir_name: str) -> str | None:
    """Newest change among the document's own files, as an ISO timestamp."""
    directory = document_dir(settings, dir_name)
    newest: float | None = None
    if not directory.is_dir():
        return None
    for entry in directory.iterdir():
        if entry.name.startswith(".") or not entry.is_file():
            continue
        stamp = entry.stat().st_mtime
        if newest is None or stamp > newest:
            newest = stamp
    if newest is None:
        return None
    return datetime.fromtimestamp(newest, tz=UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_document_file(settings: Settings, dir_name: str, filename: str) -> bytes:
    return (document_dir(settings, dir_name) / filename).read_bytes()
