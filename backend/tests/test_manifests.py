"""The backend registry and the frontend manifest must list the same tools."""

import re
from pathlib import Path

from app.tools.registry import TOOLS

FRONTEND_MANIFEST = Path(__file__).resolve().parent.parent.parent / "frontend" / "src" / "tools.ts"


def test_both_manifests_list_the_same_slugs() -> None:
    source = FRONTEND_MANIFEST.read_text(encoding="utf-8")
    frontend_slugs = re.findall(r"slug:\s*'([a-z0-9-]+)'", source)

    assert sorted(frontend_slugs) == sorted(tool.slug for tool in TOOLS)
