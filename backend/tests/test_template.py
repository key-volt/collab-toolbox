"""Holds the Python template and the vendored client-side generator together.

Two clients seeding the same empty room converge only because they start from identical
bytes. If either copy of the template changes, this test is what fails instead of sync
quietly breaking.
"""

import re
from pathlib import Path

from app.tools.drawio.template import file_template

VENDORED = (
    Path(__file__).resolve().parent.parent.parent
    / "frontend"
    / "src"
    / "vendor"
    / "y-mxgraph"
    / "binding"
    / "index.ts"
)


def test_the_template_is_byte_identical_to_the_vendored_generator() -> None:
    source = VENDORED.read_text(encoding="utf-8")
    match = re.search(
        r"generateFileTemplate\(diagramId = \"diagram-0\"\): string \{\s*return `(.*?)`;",
        source,
        re.DOTALL,
    )
    assert match is not None, "generateFileTemplate not found in the vendored source"
    vendored_template = match.group(1).replace("${diagramId}", "diagram-0")

    assert file_template() == vendored_template


def test_the_diagram_id_is_injected() -> None:
    assert '<diagram id="custom-7">' in file_template("custom-7")
