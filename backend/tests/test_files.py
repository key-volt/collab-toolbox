from fastapi.testclient import TestClient

from tests.conftest import bearer

# The sniffer reads magic bytes, so a PNG signature over arbitrary payload is enough here.
PNG = b"\x89PNG\r\n\x1a\n" + b"payload-bytes-for-the-round-trip"


def test_uploads_round_trip_with_the_sniffed_type(client: TestClient, member_token: str) -> None:
    uploaded = client.post(
        "/api/files",
        files={"file": ("anything.bin", PNG, "application/x-lie")},
        headers=bearer(member_token),
    )

    assert uploaded.status_code == 201, uploaded.text
    body = uploaded.json()
    assert body["mime"] == "image/png"

    fetched = client.get(f"/api/files/{body['id']}", headers=bearer(member_token))
    assert fetched.status_code == 200
    assert fetched.content == PNG
    assert fetched.headers["content-type"] == "image/png"
    assert fetched.headers["content-disposition"] == "attachment"
    assert "sandbox" in fetched.headers["content-security-policy"]


def test_unrecognised_bytes_are_refused(client: TestClient, member_token: str) -> None:
    response = client.post(
        "/api/files",
        files={"file": ("evil.png", b"#!/bin/sh\necho no\n", "image/png")},
        headers=bearer(member_token),
    )

    assert response.status_code == 415


def test_files_are_not_served_without_a_whitelist(
    client: TestClient, member_token: str, admin_token: str
) -> None:
    uploaded = client.post(
        "/api/files",
        files={"file": ("dot.png", PNG, "image/png")},
        headers=bearer(member_token),
    )
    file_id = uploaded.json()["id"]

    users = client.get("/api/admin/users", headers=bearer(admin_token)).json()
    member_id = next(user["id"] for user in users if user["username"] == "casey")
    client.patch(
        f"/api/admin/users/{member_id}",
        json={"is_whitelisted": False},
        headers=bearer(admin_token),
    )

    response = client.get(f"/api/files/{file_id}", headers=bearer(member_token))

    assert response.status_code == 403


def test_an_unknown_file_is_a_404(client: TestClient, member_token: str) -> None:
    assert client.get("/api/files/no-such-id", headers=bearer(member_token)).status_code == 404
