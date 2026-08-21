"""The tool interface.

The backend has no content awareness: rooms relay opaque updates, and clients do all
serialization. What a tool contributes here is only file naming, the initial files a new
document starts from, and how a pushed snapshot is validated and mirrored into the pages
table — by plain XML or JSON parsing, never through CRDT types.
"""

from dataclasses import dataclass
from typing import Protocol


class SnapshotError(Exception):
    """A pushed snapshot failed validation and was not written."""


@dataclass(frozen=True)
class PageSpec:
    ordinal: int
    title: str
    filename: str
    page_index: int | None


@dataclass(frozen=True)
class Snapshot:
    files: dict[str, bytes]
    pages: list[PageSpec]


class Tool(Protocol):
    slug: str
    title: str

    def initial_files(self) -> dict[str, bytes]:
        """The files a new document starts from."""
        ...

    def initial_pages(self) -> list[PageSpec]:
        """The pages table rows matching initial_files()."""
        ...

    def parse_snapshot(self, body: bytes) -> Snapshot:
        """Validate a pushed snapshot and return its files and page mirror.

        Raises SnapshotError when the body is not a well-formed document.
        """
        ...
