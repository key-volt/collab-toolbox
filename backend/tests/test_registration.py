from datetime import UTC, datetime, timedelta

import pytest
from altcha import Payload, create_challenge, solve_challenge
from fastapi import FastAPI
from fastapi.testclient import TestClient
from httpx import Response

from app.config import get_settings
from tests.conftest import bearer, login


def solved_payload(client: TestClient) -> str:
    """A valid captcha payload, minted and solved with the app's own signing key.

    The protocol is stateless: verification trusts any correctly signed challenge, so a
    test holding the key can use a tiny cost and solve instantly. Attackers cannot —
    they never see the key, so they can only solve the cost the server actually issues.
    """
    app = client.app
    assert isinstance(app, FastAPI)
    key: str = app.state.registration_hmac_key
    challenge = create_challenge(
        "PBKDF2/SHA-256",
        5,
        hmac_secret=key,
        expires_at=datetime.now(UTC) + timedelta(seconds=300),
    )
    solution = solve_challenge(challenge)
    assert solution is not None
    return Payload(challenge, solution).to_base64()


def register(client: TestClient, username: str, altcha: str | None = None) -> Response:
    return client.post(
        "/api/auth/register",
        json={
            "username": username,
            "password": "a-long-password",
            "altcha": altcha if altcha is not None else solved_payload(client),
        },
    )


def test_the_challenge_endpoint_answers_with_a_signed_challenge(client: TestClient) -> None:
    response = client.get("/api/auth/register/challenge")

    assert response.status_code == 200
    body = response.json()
    assert "parameters" in body
    assert body["parameters"]["algorithm"] == "PBKDF2/SHA-256"
    assert isinstance(body.get("signature"), str)


def test_registration_creates_a_pending_account_and_signs_it_in(
    client: TestClient, admin_token: str
) -> None:
    response = register(client, "newcomer")

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["user"]["username"] == "newcomer"
    assert body["user"]["is_whitelisted"] is False
    assert body["user"]["is_admin"] is False
    assert "refresh_token" in response.cookies

    # The account works as a normal pending account: it can log in…
    assert login(client, "newcomer", "a-long-password")
    # …and the admin sees it awaiting approval.
    rows = client.get("/api/admin/users", headers=bearer(admin_token)).json()
    row = next(entry for entry in rows if entry["username"] == "newcomer")
    assert row["is_whitelisted"] is False


def test_registration_is_refused_without_a_valid_captcha(client: TestClient) -> None:
    response = register(client, "botlike", altcha="bm90LWEtcmVhbC1wYXlsb2Fk")

    assert response.status_code == 422


def test_a_solved_captcha_is_single_use(client: TestClient) -> None:
    payload = solved_payload(client)

    first = register(client, "first-user", altcha=payload)
    second = register(client, "second-user", altcha=payload)

    assert first.status_code == 201
    assert second.status_code == 422


def test_registration_rejects_bad_usernames(client: TestClient) -> None:
    too_short = register(client, "ab")
    bad_chars = register(client, "not okay")
    dot_first = register(client, ".hidden")

    assert too_short.status_code == 422
    assert bad_chars.status_code == 422
    assert dot_first.status_code == 422


def test_the_admin_username_is_reserved(client: TestClient) -> None:
    response = register(client, "Admin")

    assert response.status_code == 422


def test_a_taken_username_answers_409(client: TestClient) -> None:
    first = register(client, "casey")
    second = register(client, "CASEY")

    assert first.status_code == 201
    assert second.status_code == 409


def test_the_pending_cap_closes_registration(
    client: TestClient, admin_token: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    # One pending account exists (admin-created counts the same as self-registered)…
    created = client.post(
        "/api/admin/users",
        json={"username": "waiting", "password": "a-long-password"},
        headers=bearer(admin_token),
    )
    assert created.status_code == 201
    # …and the cap is lowered to exactly that.
    monkeypatch.setenv("REGISTRATION_PENDING_MAX", "1")
    get_settings.cache_clear()

    response = register(client, "one-too-many")

    assert response.status_code == 429


def test_registration_can_be_switched_off(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("REGISTRATION_ENABLED", "false")
    get_settings.cache_clear()

    challenge = client.get("/api/auth/register/challenge")
    attempt = register(client, "nobody", altcha="aXJyZWxldmFudA==")

    assert challenge.status_code == 403
    assert attempt.status_code == 403


def test_registration_is_rate_limited_per_address(client: TestClient) -> None:
    for index in range(3):
        assert register(client, f"steady-{index}").status_code == 201

    response = register(client, "steady-3")

    assert response.status_code == 429
