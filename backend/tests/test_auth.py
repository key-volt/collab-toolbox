from fastapi.testclient import TestClient

from tests.conftest import ADMIN_PASSWORD, bearer, login


def test_login_returns_a_session_and_a_refresh_cookie(client: TestClient) -> None:
    response = client.post(
        "/api/auth/login", json={"username": "admin", "password": ADMIN_PASSWORD}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["user"]["username"] == "admin"
    assert body["user"]["is_admin"] is True
    assert body["expires_in"] > 0
    assert "refresh_token" in response.cookies


def test_login_is_case_insensitive_on_username(client: TestClient) -> None:
    response = client.post(
        "/api/auth/login", json={"username": "ADMIN", "password": ADMIN_PASSWORD}
    )

    assert response.status_code == 200


def test_login_rejects_a_wrong_password(client: TestClient) -> None:
    response = client.post("/api/auth/login", json={"username": "admin", "password": "wrong"})

    assert response.status_code == 401


def test_login_rejects_an_unknown_user_identically(client: TestClient) -> None:
    response = client.post("/api/auth/login", json={"username": "nobody", "password": "wrong"})

    assert response.status_code == 401


def test_login_is_rate_limited_per_username(client: TestClient) -> None:
    for _ in range(10):
        client.post("/api/auth/login", json={"username": "hammered", "password": "wrong"})

    response = client.post("/api/auth/login", json={"username": "hammered", "password": "wrong"})

    assert response.status_code == 429


def test_me_requires_a_token(client: TestClient) -> None:
    assert client.get("/api/auth/me").status_code == 401


def test_me_returns_the_session_user(client: TestClient, admin_token: str) -> None:
    response = client.get("/api/auth/me", headers=bearer(admin_token))

    assert response.status_code == 200
    assert response.json()["username"] == "admin"


def test_refresh_issues_a_new_access_token(client: TestClient, admin_token: str) -> None:
    response = client.post("/api/auth/refresh")

    assert response.status_code == 200
    assert response.json()["user"]["username"] == "admin"


def test_refresh_without_a_cookie_is_rejected(client: TestClient) -> None:
    assert client.post("/api/auth/refresh").status_code == 401


def test_logout_revokes_the_refresh_token(client: TestClient, admin_token: str) -> None:
    assert client.post("/api/auth/logout").status_code == 204

    assert client.post("/api/auth/refresh").status_code == 401


def test_password_change_works_for_a_member(client: TestClient, member_token: str) -> None:
    response = client.post(
        "/api/auth/password",
        json={"current_password": "a-long-password", "new_password": "another-long-one"},
        headers=bearer(member_token),
    )

    assert response.status_code == 204
    assert login(client, "casey", "another-long-one")


def test_password_change_is_refused_for_the_admin(client: TestClient, admin_token: str) -> None:
    response = client.post(
        "/api/auth/password",
        json={"current_password": ADMIN_PASSWORD, "new_password": "does-not-matter"},
        headers=bearer(admin_token),
    )

    assert response.status_code == 403


def test_password_change_requires_the_current_password(
    client: TestClient, member_token: str
) -> None:
    response = client.post(
        "/api/auth/password",
        json={"current_password": "not-it", "new_password": "another-long-one"},
        headers=bearer(member_token),
    )

    assert response.status_code == 403
