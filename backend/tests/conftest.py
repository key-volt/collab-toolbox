from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import boot
from app.config import get_settings
from app.main import create_app

ADMIN_PASSWORD = "correct-horse-battery-staple"


@pytest.fixture
def data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """Point the application at a throwaway data directory with usable secret files."""
    data = tmp_path / "data"
    secrets = tmp_path / "secrets"
    data.mkdir()
    secrets.mkdir()
    (secrets / "admin_password").write_text(ADMIN_PASSWORD + "\n", encoding="utf-8")
    (secrets / "jwt_secret").write_text("test-signing-key\n", encoding="utf-8")
    monkeypatch.setenv("DATA_DIR", str(data))
    monkeypatch.setenv("SECRETS_DIR", str(secrets))
    get_settings.cache_clear()
    yield data
    get_settings.cache_clear()


@pytest.fixture
def booted(data_dir: Path) -> Path:
    """A data directory the boot sequence has prepared: schema current, admin applied."""
    assert boot.main() == 0
    return data_dir


@pytest.fixture
def client(booted: Path) -> Iterator[TestClient]:
    with TestClient(create_app()) as test_client:
        yield test_client


def login(client: TestClient, username: str, password: str) -> str:
    response = client.post("/api/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text
    token = response.json()["access_token"]
    assert isinstance(token, str)
    return token


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def admin_token(client: TestClient) -> str:
    return login(client, "admin", ADMIN_PASSWORD)


@pytest.fixture
def member_token(client: TestClient, admin_token: str) -> str:
    """A whitelisted, non-admin account's token."""
    created = client.post(
        "/api/admin/users",
        json={"username": "casey", "password": "a-long-password"},
        headers=bearer(admin_token),
    )
    assert created.status_code == 201, created.text
    patched = client.patch(
        f"/api/admin/users/{created.json()['id']}",
        json={"is_whitelisted": True},
        headers=bearer(admin_token),
    )
    assert patched.status_code == 200, patched.text
    return login(client, "casey", "a-long-password")
