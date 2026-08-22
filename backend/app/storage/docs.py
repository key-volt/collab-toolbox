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
        target = directory / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)


def _walk_files(directory: Path) -> list[Path]:
    """Every regular file under the directory, skipping dot-named entries at any level.

    Dot names are reserved for internals (.versions, scratch files); document trees
    cannot contain them, so skipping them here never hides user content.
    """
    found: list[Path] = []
    for entry in directory.iterdir():
        if entry.name.startswith("."):
            continue
        if entry.is_dir():
            found.extend(_walk_files(entry))
        elif entry.is_file():
            found.append(entry)
    return found


def modified_at(settings: Settings, dir_name: str) -> str | None:
    """Newest change among the document's own files, as an ISO timestamp."""
    directory = document_dir(settings, dir_name)
    newest: float | None = None
    if not directory.is_dir():
        return None
    for entry in _walk_files(directory):
        stamp = entry.stat().st_mtime
        if newest is None or stamp > newest:
            newest = stamp
    if newest is None:
        return None
    return datetime.fromtimestamp(newest, tz=UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def sync_tree(
    settings: Settings, dir_name: str, keep_files: set[str], folders: set[str]
) -> None:
    """Make the directory tree match a complete snapshot manifest.

    Files the manifest no longer names are deleted (their version history stays),
    deliberately empty folders are created, and directories left with nothing in them
    are pruned. Dot-named entries are internals and are never touched.
    """
    directory = document_dir(settings, dir_name)
    if not directory.is_dir():
        return
    for entry in _walk_files(directory):
        relative = entry.relative_to(directory).as_posix()
        if relative not in keep_files:
            entry.unlink(missing_ok=True)
    for folder in folders:
        (directory / folder).mkdir(parents=True, exist_ok=True)
    keep_dirs = {str(part) for folder in folders for part in _prefixes(folder)}
    _prune_empty_dirs(directory, directory, keep_dirs)


def _prefixes(folder: str) -> list[str]:
    parts = folder.split("/")
    return ["/".join(parts[: index + 1]) for index in range(len(parts))]


def _prune_empty_dirs(root: Path, directory: Path, keep_dirs: set[str]) -> None:
    for entry in directory.iterdir():
        if entry.name.startswith(".") or not entry.is_dir():
            continue
        _prune_empty_dirs(root, entry, keep_dirs)
        relative = entry.relative_to(root).as_posix()
        if relative not in keep_dirs and not any(entry.iterdir()):
            entry.rmdir()


def read_document_file(settings: Settings, dir_name: str, filename: str) -> bytes:
    return (document_dir(settings, dir_name) / filename).read_bytes()
