import json
from pathlib import Path

from fastapi.testclient import TestClient

from tests.conftest import bearer

TWO_PAGE_MXFILE = (
    '<mxfile pages="2">'
    '<diagram id="diagram-0" name="Overview"><mxGraphModel><root>'
    '<mxCell id="0" /><mxCell id="1" parent="0" />'
    "</root></mxGraphModel></diagram>"
    '<diagram id="diagram-1" name="Detail"><mxGraphModel><root>'
    '<mxCell id="0" /><mxCell id="1" parent="0" />'
    "</root></mxGraphModel></diagram>"
    "</mxfile>"
)

ENTITY_ATTACK = (
    '<?xml version="1.0"?><!DOCTYPE mxfile [<!ENTITY a "aaaa">]>'
    "<mxfile><diagram id='d'>&a;</diagram></mxfile>"
)


def _create(client: TestClient, token: str, tool: str, title: str) -> str:
    response = client.post(
        "/api/documents", json={"tool": tool, "title": title}, headers=bearer(token)
    )
    assert response.status_code == 201
    doc_id = response.json()["id"]
    assert isinstance(doc_id, str)
    return doc_id


def test_a_drawio_snapshot_writes_the_file_and_mirrors_pages(
    client: TestClient, member_token: str, booted: Path
) -> None:
    doc_id = _create(client, member_token, "drawio", "Plan")

    response = client.post(
        f"/api/tools/drawio/{doc_id}/snapshot",
        content=TWO_PAGE_MXFILE.encode("utf-8"),
        headers=bearer(member_token),
    )

    assert response.status_code == 200
    assert response.json() == {"version_written": True}

    detail = client.get(f"/api/documents/{doc_id}", headers=bearer(member_token)).json()
    assert [page["title"] for page in detail["pages"]] == ["Overview", "Detail"]
    assert [page["page_index"] for page in detail["pages"]] == [0, 1]

    stored = next((booted / "docs").glob("plan-*/document.drawio")).read_text(encoding="utf-8")
    assert stored == TWO_PAGE_MXFILE


def test_an_unchanged_snapshot_writes_no_second_version(
    client: TestClient, member_token: str
) -> None:
    doc_id = _create(client, member_token, "drawio", "Plan")

    first = client.post(
        f"/api/tools/drawio/{doc_id}/snapshot",
        content=TWO_PAGE_MXFILE.encode("utf-8"),
        headers=bearer(member_token),
    )
    second = client.post(
        f"/api/tools/drawio/{doc_id}/snapshot",
        content=TWO_PAGE_MXFILE.encode("utf-8"),
        headers=bearer(member_token),
    )

    assert first.json() == {"version_written": True}
    assert second.json() == {"version_written": False}

    versions = client.get(f"/api/documents/{doc_id}/versions", headers=bearer(member_token))
    assert len(versions.json()) == 1


def test_a_version_can_be_read_back(client: TestClient, member_token: str) -> None:
    doc_id = _create(client, member_token, "drawio", "Plan")
    client.post(
        f"/api/tools/drawio/{doc_id}/snapshot",
        content=TWO_PAGE_MXFILE.encode("utf-8"),
        headers=bearer(member_token),
    )

    listed = client.get(f"/api/documents/{doc_id}/versions", headers=bearer(member_token)).json()
    content = client.get(
        f"/api/documents/{doc_id}/versions/{listed[0]['name']}", headers=bearer(member_token)
    )

    assert content.status_code == 200
    assert content.text == TWO_PAGE_MXFILE


def test_malformed_snapshots_are_refused(client: TestClient, member_token: str) -> None:
    doc_id = _create(client, member_token, "drawio", "Plan")

    not_xml = client.post(
        f"/api/tools/drawio/{doc_id}/snapshot",
        content=b"this is not xml",
        headers=bearer(member_token),
    )
    wrong_root = client.post(
        f"/api/tools/drawio/{doc_id}/snapshot",
        content=b"<svg></svg>",
        headers=bearer(member_token),
    )
    entity_attack = client.post(
        f"/api/tools/drawio/{doc_id}/snapshot",
        content=ENTITY_ATTACK.encode("utf-8"),
        headers=bearer(member_token),
    )

    assert not_xml.status_code == 422
    assert wrong_root.status_code == 422
    assert entity_attack.status_code == 422


def test_a_snapshot_for_the_wrong_tool_is_refused(client: TestClient, member_token: str) -> None:
    doc_id = _create(client, member_token, "paint", "Board")

    response = client.post(
        f"/api/tools/drawio/{doc_id}/snapshot",
        content=TWO_PAGE_MXFILE.encode("utf-8"),
        headers=bearer(member_token),
    )

    assert response.status_code == 404


def test_a_paint_snapshot_writes_one_file_per_page(
    client: TestClient, member_token: str, booted: Path
) -> None:
    doc_id = _create(client, member_token, "paint", "Board")
    payload = {
        "pages": [
            {
                "id": "p1",
                "title": "Sketch",
                "content": {"type": "excalidraw", "version": 2, "elements": [], "files": {}},
            },
            {
                "id": "p2",
                "title": "Final",
                "content": {"type": "excalidraw", "version": 2, "elements": [], "files": {}},
            },
        ]
    }

    response = client.post(
        f"/api/tools/paint/{doc_id}/snapshot",
        content=json.dumps(payload).encode("utf-8"),
        headers=bearer(member_token),
    )

    assert response.status_code == 200
    doc_dir = next((booted / "docs").glob("board-*"))
    assert (doc_dir / "page-1.excalidraw").is_file()
    assert (doc_dir / "page-2.excalidraw").is_file()

    detail = client.get(f"/api/documents/{doc_id}", headers=bearer(member_token)).json()
    assert [page["title"] for page in detail["pages"]] == ["Sketch", "Final"]


def test_a_paint_snapshot_with_bad_content_is_refused(
    client: TestClient, member_token: str
) -> None:
    doc_id = _create(client, member_token, "paint", "Board")

    response = client.post(
        f"/api/tools/paint/{doc_id}/snapshot",
        content=json.dumps({"pages": [{"id": "p", "content": {"type": "nonsense"}}]}).encode(),
        headers=bearer(member_token),
    )

    assert response.status_code == 422
