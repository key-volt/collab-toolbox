from pathlib import Path

from fastapi.testclient import TestClient

from app.tools.drawio.template import file_template
from tests.conftest import bearer, create_member


def _create(client: TestClient, token: str, tool: str, title: str) -> dict[str, object]:
    response = client.post(
        "/api/documents", json={"tool": tool, "title": title}, headers=bearer(token)
    )
    assert response.status_code == 201, response.text
    body: dict[str, object] = response.json()
    return body


def _second_member(client: TestClient, admin_token: str, username: str) -> str:
    """Another approved, non-admin account — someone who owns nothing."""
    return create_member(client, admin_token, username)


def test_documents_require_a_whitelisted_account(client: TestClient) -> None:
    assert client.get("/api/documents").status_code == 401


def test_a_new_diagram_starts_from_the_fixed_template(
    client: TestClient, member_token: str, booted: Path
) -> None:
    document = _create(client, member_token, "drawio", "Network plan")

    stored = next((booted / "docs").glob("network-plan-*/document.drawio")).read_bytes()
    assert stored == file_template().encode("utf-8")
    pages = document["pages"]
    assert isinstance(pages, list)
    assert len(pages) == 1


def test_a_new_paint_document_starts_with_one_page(
    client: TestClient, member_token: str, booted: Path
) -> None:
    _create(client, member_token, "paint", "Moodboard")

    stored = next((booted / "docs").glob("moodboard-*/page-1.excalidraw")).read_bytes()
    assert b'"excalidraw"' in stored


def test_an_unknown_tool_is_refused(client: TestClient, member_token: str) -> None:
    response = client.post(
        "/api/documents", json={"tool": "carving", "title": "x"}, headers=bearer(member_token)
    )

    assert response.status_code == 422


def test_listing_shows_documents_newest_first_with_counts(
    client: TestClient, member_token: str
) -> None:
    _create(client, member_token, "drawio", "First")
    _create(client, member_token, "paint", "Second")

    listed = client.get("/api/documents", headers=bearer(member_token)).json()

    assert [row["page_count"] for row in listed] == [1, 1]
    assert {row["tool"] for row in listed} == {"drawio", "paint"}

    filtered = client.get("/api/documents?tool=paint", headers=bearer(member_token)).json()
    assert len(filtered) == 1
    assert filtered[0]["title"] == "Second"


def test_rename(client: TestClient, member_token: str) -> None:
    document = _create(client, member_token, "drawio", "Old name")

    response = client.patch(
        f"/api/documents/{document['id']}",
        json={"title": "New name"},
        headers=bearer(member_token),
    )

    assert response.status_code == 200
    assert response.json()["title"] == "New name"


def test_document_files_are_served_only_by_known_name(
    client: TestClient, member_token: str
) -> None:
    document = _create(client, member_token, "drawio", "Plan")

    good = client.get(
        f"/api/documents/{document['id']}/files/document.drawio", headers=bearer(member_token)
    )
    bad = client.get(
        f"/api/documents/{document['id']}/files/../../etc/passwd", headers=bearer(member_token)
    )

    assert good.status_code == 200
    assert good.content == file_template().encode("utf-8")
    assert bad.status_code == 404


def test_delete_needs_the_owner_or_an_admin_and_goes_to_trash(
    client: TestClient, admin_token: str, member_token: str, booted: Path
) -> None:
    document = _create(client, member_token, "drawio", "Disposable")
    other_token = _second_member(client, admin_token, "rowan")

    refused = client.delete(f"/api/documents/{document['id']}", headers=bearer(other_token))
    assert refused.status_code == 403

    deleted = client.delete(f"/api/documents/{document['id']}", headers=bearer(member_token))
    assert deleted.status_code == 204
    assert client.get("/api/documents", headers=bearer(member_token)).json() == []
    assert list((booted / "docs" / ".trash").iterdir()) != []


def test_trash_restore_brings_the_document_back(
    client: TestClient, admin_token: str, member_token: str
) -> None:
    document = _create(client, member_token, "drawio", "Precious")
    client.delete(f"/api/documents/{document['id']}", headers=bearer(admin_token))

    trashed = client.get("/api/admin/trash", headers=bearer(admin_token)).json()
    assert len(trashed) == 1
    assert trashed[0]["title"] == "Precious"

    restored = client.post(
        f"/api/admin/trash/{trashed[0]['name']}/restore", headers=bearer(admin_token)
    )
    assert restored.status_code == 204

    listed = client.get("/api/documents", headers=bearer(member_token)).json()
    assert [row["title"] for row in listed] == ["Precious"]
    detail = client.get(f"/api/documents/{document['id']}", headers=bearer(member_token))
    assert detail.status_code == 200
    assert len(detail.json()["pages"]) == 1
