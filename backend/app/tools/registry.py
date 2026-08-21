"""The manifest — the only place tools are listed.

Adding a tool means adding its folder and one entry here. The frontend keeps a mirror of
this list, and a test asserts the two agree.
"""

from app.tools.base import Tool
from app.tools.drawio.store import DrawioTool
from app.tools.paint.store import PaintTool

TOOLS: tuple[Tool, ...] = (DrawioTool(), PaintTool())


def get_tool(slug: str) -> Tool | None:
    for tool in TOOLS:
        if tool.slug == slug:
            return tool
    return None
