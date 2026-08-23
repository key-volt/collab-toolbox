"""Per-document access: names are public, content is granted, revocation is immediate."""

import pytest
from fastapi.testclient import TestClient
from pycrdt import YMessageType, YSyncMessageType
from starlette.testclient import WebSocketDenialResponse
from starlette.websockets import WebSocketDisconnect

from app.tools.room import _write_allowed_for_reader
from tests.conftest import bearer, create_member

REJECTED = (WebSocketDisconnect, WebSocketDenialResponse)

SNAPSHOT = '{"pages": [{"title": "Page 1", "content": {"type": "excalidraw", "elements": []}}]}'


def _create(client: TestClient, token: str, title: str) -> str:
    response = client.post(
        "/api/documents", json={"tool": "paint", "title": title}, headers=bearer(token)
    )
    assert response.status_code == 201, response.text
    doc_id = response.json()["id"]
    assert isinstance(doc_id, str)
    return doc_id


def _grant(
    client: TestClient, owner_token: str, doc_id: str, entries: list[dict[str, str]]
) -> None:
    response = client.put(
        f"/api/documents/{doc_id}/access",
        json={"entries": entries},
        headers=bearer(owner_token),
    )
    assert response.status_code == 200, response.text


def _user_id(client: TestClient, admin_token: str, username: str) -> str:
    users = client.get("/api/admin/users", headers=bearer(admin_token)).json()
    matched = next(user["id"] for user in users if user["username"] == username)
    assert isinstance(matched, str)
    return matched


def test_names_are_listed_but_content_is_not_readable_without_a_grant(
    client: TestClient, admin_token: str, member_token: str
) -> None:
    doc_id = _create(client, member_token, "Private board")
    other_token = create_member(client, admin_token, "rowan")

    listed = client.get("/api/documents", headers=bearer(other_token)).json()
    assert [row["title"] for row in listed] == ["Private board"]
    assert listed[0]["access"] == "none"
    assert listed[0]["owner"] == "casey"

    assert client.get(f"/api/documents/{doc_id}", headers=bearer(other_token)).status_code == 403
    files = client.get(
        f"/api/documents/{doc_id}/files/page-1.excalidraw", headers=bearer(other_token)
    )
    assert files.status_code == 403
    versions = client.get(f"/api/documents/{doc_id}/versions", headers=bearer(other_token))
    assert versions.status_code == 403


def test_read_grants_reading_but_not_writing(
    client: TestClient, admin_token: str, member_token: str
) -> None:
    doc_id = _create(client, member_token, "Board")
    other_token = create_member(client, admin_token, "rowan")
    other_id = _user_id(client, admin_token, "rowan")

    _grant(client, member_token, doc_id, [{"user_id": other_id, "level": "read"}])

    detail = client.get(f"/api/documents/{doc_id}", headers=bearer(other_token))
    assert detail.status_code == 200
    assert detail.json()["access"] == "read"
    pushed = client.post(
        f"/api/tools/paint/{doc_id}/snapshot",
        content=SNAPSHOT.encode("utf-8"),
        headers=bearer(other_token),
    )
    assert pushed.status_code == 403
    renamed = client.patch(
        f"/api/documents/{doc_id}", json={"title": "Taken over"}, headers=bearer(other_token)
    )
    assert renamed.status_code == 403


def test_edit_grants_writing_and_a_downgrade_takes_it_back(
    client: TestClient, admin_token: str, member_token: str
) -> None:
    doc_id = _create(client, member_token, "Board")
    other_token = create_member(client, admin_token, "rowan")
    other_id = _user_id(client, admin_token, "rowan")

    _grant(client, member_token, doc_id, [{"user_id": other_id, "level": "edit"}])
    pushed = client.post(
        f"/api/tools/paint/{doc_id}/snapshot",
        content=SNAPSHOT.encode("utf-8"),
        headers=bearer(other_token),
    )
    assert pushed.status_code == 200

    _grant(client, member_token, doc_id, [{"user_id": other_id, "level": "read"}])
    downgraded = client.post(
        f"/api/tools/paint/{doc_id}/snapshot",
        content=SNAPSHOT.encode("utf-8"),
        headers=bearer(other_token),
    )
    assert downgraded.status_code == 403

    _grant(client, member_token, doc_id, [])
    assert client.get(f"/api/documents/{doc_id}", headers=bearer(other_token)).status_code == 403


def test_grants_are_managed_by_the_owner_only(
    client: TestClient, admin_token: str, member_token: str
) -> None:
    doc_id = _create(client, member_token, "Board")
    other_token = create_member(client, admin_token, "rowan")
    other_id = _user_id(client, admin_token, "rowan")
    _grant(client, member_token, doc_id, [{"user_id": other_id, "level": "edit"}])

    # An editor neither reads nor writes the grant list.
    listed = client.get(f"/api/documents/{doc_id}/access", headers=bearer(other_token))
    assert listed.status_code == 403
    refused = client.put(
        f"/api/documents/{doc_id}/access", json={"entries": []}, headers=bearer(other_token)
    )
    assert refused.status_code == 403

    info = client.get(f"/api/documents/{doc_id}/access", headers=bearer(member_token)).json()
    assert info["owner"] == "casey"
    assert [entry["username"] for entry in info["entries"]] == ["rowan"]
    assert [candidate["username"] for candidate in info["candidates"]] == ["rowan"]


def test_grants_never_name_admins_the_owner_or_strangers(
    client: TestClient, admin_token: str, member_token: str
) -> None:
    doc_id = _create(client, member_token, "Board")
    admin_id = _user_id(client, admin_token, "admin")
    owner_id = _user_id(client, admin_token, "casey")

    for target in (admin_id, owner_id, "no-such-user"):
        response = client.put(
            f"/api/documents/{doc_id}/access",
            json={"entries": [{"user_id": target, "level": "read"}]},
            headers=bearer(member_token),
        )
        assert response.status_code == 422, target


def test_admins_have_access_without_any_grant(
    client: TestClient, admin_token: str, member_token: str
) -> None:
    doc_id = _create(client, member_token, "Board")

    detail = client.get(f"/api/documents/{doc_id}", headers=bearer(admin_token))
    assert detail.status_code == 200
    assert detail.json()["access"] == "manage"
    pushed = client.post(
        f"/api/tools/paint/{doc_id}/snapshot",
        content=SNAPSHOT.encode("utf-8"),
        headers=bearer(admin_token),
    )
    assert pushed.status_code == 200


def test_grants_survive_trash_and_restore(
    client: TestClient, admin_token: str, member_token: str
) -> None:
    doc_id = _create(client, member_token, "Board")
    other_token = create_member(client, admin_token, "rowan")
    other_id = _user_id(client, admin_token, "rowan")
    _grant(client, member_token, doc_id, [{"user_id": other_id, "level": "read"}])

    deleted = client.delete(f"/api/documents/{doc_id}", headers=bearer(member_token))
    assert deleted.status_code == 204
    trashed = client.get("/api/admin/trash", headers=bearer(admin_token)).json()
    restored = client.post(
        f"/api/admin/trash/{trashed[0]['name']}/restore", headers=bearer(admin_token)
    )
    assert restored.status_code == 204

    detail = client.get(f"/api/documents/{doc_id}", headers=bearer(other_token))
    assert detail.status_code == 200
    assert detail.json()["access"] == "read"
    owner_detail = client.get(f"/api/documents/{doc_id}", headers=bearer(member_token))
    assert owner_detail.json()["access"] == "manage"


def test_the_room_requires_read_access(
    client: TestClient, admin_token: str, member_token: str
) -> None:
    doc_id = _create(client, member_token, "Board")
    other_token = create_member(client, admin_token, "rowan")
    other_id = _user_id(client, admin_token, "rowan")

    with (
        pytest.raises(REJECTED),
        client.websocket_connect(
            f"/ws/paint/{doc_id}", subprotocols=["collab.v1", f"bearer.{other_token}"]
        ),
    ):
        pass

    _grant(client, member_token, doc_id, [{"user_id": other_id, "level": "read"}])
    with client.websocket_connect(
        f"/ws/paint/{doc_id}", subprotocols=["collab.v1", f"bearer.{other_token}"]
    ) as connection:
        assert connection.accepted_subprotocol == "collab.v1"


def test_the_reader_filter_passes_only_awareness_and_sync_step_1() -> None:
    step1 = bytes([YMessageType.SYNC, YSyncMessageType.SYNC_STEP1])
    step2 = bytes([YMessageType.SYNC, YSyncMessageType.SYNC_STEP2]) + b"\x00"
    update = bytes([YMessageType.SYNC, YSyncMessageType.SYNC_UPDATE]) + b"\x00"
    awareness = bytes([YMessageType.AWARENESS]) + b"\x00"

    assert _write_allowed_for_reader(awareness) is True
    assert _write_allowed_for_reader(step1) is True
    assert _write_allowed_for_reader(step2) is False
    assert _write_allowed_for_reader(update) is False
    assert _write_allowed_for_reader(b"") is False
    assert _write_allowed_for_reader(bytes([YMessageType.SYNC])) is False
