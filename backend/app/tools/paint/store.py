"""Paint storage: one readable snapshot file per page.

The pushed snapshot is JSON carrying every page in tab order. Each page's content is a
standard .excalidraw document serialized by the client; the backend checks the shape and
writes bytes, nothing more.
"""

import json
from typing import Any

from app.tools.base import PageSpec, Snapshot, SnapshotError

EMPTY_PAGE: dict[str, Any] = {
    "type": "excalidraw",
    "version": 2,
    "elements": [],
    "appState": {},
    "files": {},
}


def _page_filename(ordinal: int) -> str:
    return f"page-{ordinal}.excalidraw"


def _serialize(content: dict[str, Any]) -> bytes:
    return (json.dumps(content, indent=2) + "\n").encode("utf-8")


class PaintTool:
    slug = "paint"
    title = "Paint"

    def initial_files(self) -> dict[str, bytes]:
        return {_page_filename(1): _serialize(EMPTY_PAGE)}

    def initial_pages(self) -> list[PageSpec]:
        return [PageSpec(ordinal=1, title="Page 1", filename=_page_filename(1), page_index=None)]

    def parse_snapshot(self, body: bytes) -> Snapshot:
        try:
            payload = json.loads(body)
        except ValueError as exc:
            raise SnapshotError("snapshot is not valid JSON") from exc
        if not isinstance(payload, dict) or not isinstance(payload.get("pages"), list):
            raise SnapshotError("snapshot must be an object with a pages list")
        raw_pages: list[Any] = payload["pages"]
        if not raw_pages:
            raise SnapshotError("snapshot contains no pages")
        files: dict[str, bytes] = {}
        pages: list[PageSpec] = []
        for index, raw in enumerate(raw_pages):
            if not isinstance(raw, dict):
                raise SnapshotError("each page must be an object")
            content = raw.get("content")
            if (
                not isinstance(content, dict)
                or content.get("type") != "excalidraw"
                or not isinstance(content.get("elements"), list)
            ):
                raise SnapshotError("each page content must be an excalidraw document")
            ordinal = index + 1
            title = raw.get("title")
            if not isinstance(title, str) or not title.strip():
                title = f"Page {ordinal}"
            filename = _page_filename(ordinal)
            files[filename] = _serialize(content)
            pages.append(
                PageSpec(ordinal=ordinal, title=title.strip(), filename=filename, page_index=None)
            )
        return Snapshot(files=files, pages=pages)
