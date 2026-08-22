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
    # Folders that exist even though no file lives in them yet. Only meaningful for
    # tools whose documents are directory trees.
    folders: tuple[str, ...] = ()


class Tool(Protocol):
    slug: str
    title: str
    # True when the document is a directory tree the snapshot describes completely:
    # after writing, files on disk that the snapshot no longer names are deleted and
    # empty folders it names are created. Flat-file tools leave this off.
    sync_tree: bool

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
