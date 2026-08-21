from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app


def test_health_reports_ok(data_dir: Path) -> None:
    with TestClient(create_app()) as client:
        response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_health_reports_unavailable_when_storage_is_missing(
    data_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DATA_DIR", str(data_dir / "absent"))
    get_settings.cache_clear()
    try:
        with TestClient(create_app()) as client:
            response = client.get("/api/health")
    finally:
        get_settings.cache_clear()

    assert response.status_code == 503
    assert response.json() == {"status": "unavailable"}
