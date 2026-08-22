"""Code storage: a project is a directory tree of text files.

The pushed snapshot is a JSON manifest naming every file with its full content, plus any
folders that are deliberately empty. The backend validates paths and ceilings and writes
bytes; it never parses the code itself. Because the snapshot describes the whole tree,
the writer also deletes files the manifest no longer names (sync_tree).
"""

import json
import re
from typing import Any

from app.config import get_settings
from app.tools.base import PageSpec, Snapshot, SnapshotError

INITIAL_FILE = "main.py"
INITIAL_CONTENT = b'print("Hello, world!")\n'

# One path component: short, printable, and never dot-first — that reserves the
# .versions and .trash names and keeps hidden files out of project trees.
_COMPONENT = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$")

MAX_PATH_LENGTH = 200
MAX_FOLDER_DEPTH = 8
MAX_EMPTY_FOLDERS = 50


def path_error(path: str, *, is_folder: bool = False) -> str | None:
    """Why a relative path is not acceptable, or None when it is."""
    if not isinstance(path, str) or path == "":
        return "a path must be a non-empty string"
    if len(path) > MAX_PATH_LENGTH:
        return f"a path may be at most {MAX_PATH_LENGTH} characters: '{path[:40]}…'"
    parts = path.split("/")
    depth_limit = MAX_FOLDER_DEPTH if is_folder else MAX_FOLDER_DEPTH + 1
    if len(parts) > depth_limit:
        return f"'{path}' nests deeper than {MAX_FOLDER_DEPTH} folders"
    for part in parts:
        if not _COMPONENT.match(part):
            return (
                f"'{path}' contains the invalid name '{part}' — names use letters, digits, "
                "'.', '_' and '-', do not start with a dot, and stay under 64 characters"
            )
    return None


class CodeTool:
    slug = "code"
    title = "Code"
    sync_tree = True

    def initial_files(self) -> dict[str, bytes]:
        return {INITIAL_FILE: INITIAL_CONTENT}

    def initial_pages(self) -> list[PageSpec]:
        return [PageSpec(ordinal=1, title=INITIAL_FILE, filename=INITIAL_FILE, page_index=None)]

    def parse_snapshot(self, body: bytes) -> Snapshot:
        settings = get_settings()
        try:
            payload = json.loads(body)
        except ValueError as exc:
            raise SnapshotError("snapshot is not valid JSON") from exc
        if not isinstance(payload, dict) or not isinstance(payload.get("files"), list):
            raise SnapshotError("snapshot must be an object with a files list")

        raw_files: list[Any] = payload["files"]
        if not raw_files:
            raise SnapshotError("snapshot contains no files")
        if len(raw_files) > settings.code_max_files:
            raise SnapshotError(f"a project may hold at most {settings.code_max_files} files")

        file_cap = settings.code_max_file_kb * 1024
        total_cap = settings.code_max_project_mb * 1024 * 1024
        total = 0
        files: dict[str, bytes] = {}
        for raw in raw_files:
            if not isinstance(raw, dict):
                raise SnapshotError("each file must be an object")
            path = raw.get("path")
            text = raw.get("text")
            if not isinstance(path, str) or not isinstance(text, str):
                raise SnapshotError("each file needs a string path and string text")
            problem = path_error(path)
            if problem is not None:
                raise SnapshotError(problem)
            if path in files:
                raise SnapshotError(f"the path '{path}' appears twice")
            if "\x00" in text:
                raise SnapshotError(f"'{path}' contains a NUL byte — only text files are stored")
            content = text.encode("utf-8")
            if len(content) > file_cap:
                raise SnapshotError(
                    f"'{path}' is larger than the {settings.code_max_file_kb} kB file limit"
                )
            total += len(content)
            if total > total_cap:
                raise SnapshotError(
                    f"the project is larger than the {settings.code_max_project_mb} MB limit"
                )
            files[path] = content

        raw_folders = payload.get("folders", [])
        if not isinstance(raw_folders, list):
            raise SnapshotError("folders must be a list")
        if len(raw_folders) > MAX_EMPTY_FOLDERS:
            raise SnapshotError(f"at most {MAX_EMPTY_FOLDERS} empty folders are kept")
        folders: list[str] = []
        for raw in raw_folders:
            problem = path_error(raw if isinstance(raw, str) else "", is_folder=True)
            if problem is not None:
                raise SnapshotError(problem)
            folder = str(raw)
            if folder in files:
                raise SnapshotError(f"'{folder}' is both a folder and a file")
            if folder not in folders:
                folders.append(folder)

        pages = [
            PageSpec(ordinal=index + 1, title=path, filename=path, page_index=None)
            for index, path in enumerate(sorted(files))
        ]
        return Snapshot(files=files, pages=pages, folders=tuple(folders))
