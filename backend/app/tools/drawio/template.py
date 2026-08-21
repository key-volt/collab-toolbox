"""The fixed initial file for a new diagram.

Clients seeding the same shared document must start from identical bytes — identical
diagram ids are what make two clients seeding an empty room converge instead of
duplicating pages. This string is therefore byte-for-byte the output of the client-side
template generator, and a test holds the two together.
"""

DEFAULT_DIAGRAM_ID = "diagram-0"


def file_template(diagram_id: str = DEFAULT_DIAGRAM_ID) -> str:
    return (
        '<mxfile pages="1">\n'
        f'  <diagram id="{diagram_id}">\n'
        "    <mxGraphModel>\n"
        "      <root>\n"
        '        <mxCell id="0" />\n'
        '        <mxCell id="1" parent="0" />\n'
        "      </root>\n"
        "    </mxGraphModel>\n"
        "  </diagram>\n"
        "</mxfile>"
    )
