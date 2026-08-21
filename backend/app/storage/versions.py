"""Version history for document files.

A snapshot writes a new version only when the content hash differs from the newest
existing version of that file, so an idle document costs nothing. Retention is a count
and an age, applied per file.
"""

import hashlib
import os
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

VERSIONS_DIR = ".versions"

_VERSION_NAME = re.compile(r"^(?P<stamp>\d{8}T\d{6}Z)-(?P<filename>[^/\\]+)$")


@dataclass(frozen=True)
class VersionInfo:
    name: str
    filename: str
    stamp: str
    size: int


def _timestamp() -> str:
    return datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")


def _digest(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _versions_of(versions_dir: Path, filename: str) -> list[Path]:
    """Versions of one file, newest first. Timestamps sort lexicographically."""
    if not versions_dir.is_dir():
        return []
    matches = []
    for entry in versions_dir.iterdir():
        parsed = _VERSION_NAME.match(entry.name)
        if parsed is not None and parsed.group("filename") == filename:
            matches.append(entry)
    return sorted(matches, key=lambda path: path.name, reverse=True)


def write_snapshot(doc_dir: Path, filename: str, content: bytes, keep: int, days: int) -> bool:
    """Write the current file, and a version entry when the content actually changed."""
    current = doc_dir / filename
    scratch = doc_dir / f".{filename}.tmp"
    scratch.write_bytes(content)
    os.replace(scratch, current)

    versions_dir = doc_dir / VERSIONS_DIR
    existing = _versions_of(versions_dir, filename)
    if existing and _digest(existing[0].read_bytes()) == _digest(content):
        return False
    versions_dir.mkdir(exist_ok=True)
    (versions_dir / f"{_timestamp()}-{filename}").write_bytes(content)
    prune_versions(doc_dir, keep, days)
    return True


def list_versions(doc_dir: Path) -> list[VersionInfo]:
    versions_dir = doc_dir / VERSIONS_DIR
    if not versions_dir.is_dir():
        return []
    found = []
    for entry in versions_dir.iterdir():
        parsed = _VERSION_NAME.match(entry.name)
        if parsed is None or not entry.is_file():
            continue
        found.append(
            VersionInfo(
                name=entry.name,
                filename=parsed.group("filename"),
                stamp=parsed.group("stamp"),
                size=entry.stat().st_size,
            )
        )
    return sorted(found, key=lambda info: info.name, reverse=True)


def read_version(doc_dir: Path, name: str) -> bytes | None:
    if _VERSION_NAME.match(name) is None:
        return None
    path = doc_dir / VERSIONS_DIR / name
    if not path.is_file():
        return None
    return path.read_bytes()


def prune_versions(doc_dir: Path, keep: int, days: int) -> None:
    versions_dir = doc_dir / VERSIONS_DIR
    if not versions_dir.is_dir():
        return
    cutoff = (datetime.now(UTC) - timedelta(days=days)).strftime("%Y%m%dT%H%M%SZ")
    filenames = {info.filename for info in list_versions(doc_dir)}
    for filename in filenames:
        for index, path in enumerate(_versions_of(versions_dir, filename)):
            parsed = _VERSION_NAME.match(path.name)
            if parsed is None:
                continue
            if index >= keep or parsed.group("stamp") < cutoff:
                path.unlink(missing_ok=True)
