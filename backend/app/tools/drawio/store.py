"""draw.io storage: one natively multi-page file.

The pushed snapshot is the serialized mxfile XML. It is parsed here as plain XML with a
hardened parser — pushes come from clients — solely to mirror the page list; the diagram
content itself is opaque to the backend.
"""

from defusedxml import ElementTree
from defusedxml.common import DefusedXmlException

from app.tools.base import PageSpec, Snapshot, SnapshotError
from app.tools.drawio.template import file_template

FILENAME = "document.drawio"


class DrawioTool:
    slug = "drawio"
    title = "Diagrams"

    def initial_files(self) -> dict[str, bytes]:
        return {FILENAME: file_template().encode("utf-8")}

    def initial_pages(self) -> list[PageSpec]:
        return [PageSpec(ordinal=1, title="Page-1", filename=FILENAME, page_index=0)]

    def parse_snapshot(self, body: bytes) -> Snapshot:
        try:
            root = ElementTree.fromstring(body.decode("utf-8"))
        except UnicodeDecodeError as exc:
            raise SnapshotError("snapshot is not UTF-8 text") from exc
        except (ElementTree.ParseError, DefusedXmlException) as exc:
            raise SnapshotError("snapshot is not well-formed XML") from exc
        if root.tag != "mxfile":
            raise SnapshotError("snapshot root element is not <mxfile>")
        diagrams = root.findall("diagram")
        if not diagrams:
            raise SnapshotError("snapshot contains no <diagram> element")
        pages = [
            PageSpec(
                ordinal=index + 1,
                title=diagram.get("name") or f"Page-{index + 1}",
                filename=FILENAME,
                page_index=index,
            )
            for index, diagram in enumerate(diagrams)
        ]
        return Snapshot(files={FILENAME: body}, pages=pages)
