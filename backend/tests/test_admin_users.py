from fastapi.testclient import TestClient

from tests.conftest import bearer, login


def _create(client: TestClient, admin_token: str, username: str) -> str:
    response = client.post(
        "/api/admin/users",
        json={"username": username, "password": "a-long-password"},
        headers=bearer(admin_token),
    )
    assert response.status_code == 201, response.text
    user_id = response.json()["id"]
    assert isinstance(user_id, str)
    return user_id


def test_user_routes_require_the_admin(client: TestClient, member_token: str) -> None:
    assert client.get("/api/admin/users", headers=bearer(member_token)).status_code == 403


def test_created_users_start_outside_the_whitelist(client: TestClient, admin_token: str) -> None:
    _create(client, admin_token, "dana")

    token = login(client, "dana", "a-long-password")
    assert client.get("/api/auth/me", headers=bearer(token)).json()["is_whitelisted"] is False
    assert client.get("/api/documents", headers=bearer(token)).status_code == 403


def test_whitelisting_takes_effect_on_the_next_request(
    client: TestClient, admin_token: str
) -> None:
    user_id = _create(client, admin_token, "dana")
    token = login(client, "dana", "a-long-password")

    patched = client.patch(
        f"/api/admin/users/{user_id}",
        json={"is_whitelisted": True},
        headers=bearer(admin_token),
    )
    assert patched.status_code == 200
    assert client.get("/api/documents", headers=bearer(token)).status_code == 200

    client.patch(
        f"/api/admin/users/{user_id}",
        json={"is_whitelisted": False},
        headers=bearer(admin_token),
    )
    assert client.get("/api/documents", headers=bearer(token)).status_code == 403


def test_patch_rejects_the_admin_flag_outright(client: TestClient, admin_token: str) -> None:
    user_id = _create(client, admin_token, "dana")

    response = client.patch(
        f"/api/admin/users/{user_id}",
        json={"is_whitelisted": True, "is_admin": True},
        headers=bearer(admin_token),
    )

    assert response.status_code == 422


def test_duplicate_usernames_are_refused(client: TestClient, admin_token: str) -> None:
    _create(client, admin_token, "dana")

    response = client.post(
        "/api/admin/users",
        json={"username": "dana", "password": "a-long-password"},
        headers=bearer(admin_token),
    )

    assert response.status_code == 409


def test_the_admin_account_cannot_be_changed_or_deleted(
    client: TestClient, admin_token: str
) -> None:
    users = client.get("/api/admin/users", headers=bearer(admin_token)).json()
    admin_id = next(user["id"] for user in users if user["is_admin"])

    patched = client.patch(
        f"/api/admin/users/{admin_id}",
        json={"is_whitelisted": False},
        headers=bearer(admin_token),
    )
    deleted = client.delete(f"/api/admin/users/{admin_id}", headers=bearer(admin_token))

    assert patched.status_code == 403
    assert deleted.status_code == 403


def test_deleting_a_user_ends_their_sessions(client: TestClient, admin_token: str) -> None:
    user_id = _create(client, admin_token, "dana")
    token = login(client, "dana", "a-long-password")

    deleted = client.delete(f"/api/admin/users/{user_id}", headers=bearer(admin_token))

    assert deleted.status_code == 204
    assert client.get("/api/auth/me", headers=bearer(token)).status_code == 401
