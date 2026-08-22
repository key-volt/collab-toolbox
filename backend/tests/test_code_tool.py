import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx import Response

from app.config import get_settings
from tests.conftest import bearer


def create_project(client: TestClient, token: str, title: str) -> str:
    response = client.post(
        "/api/documents", json={"tool": "code", "title": title}, headers=bearer(token)
    )
    assert response.status_code == 201, response.text
    doc_id = response.json()["id"]
    assert isinstance(doc_id, str)
    return doc_id


def push(
    client: TestClient,
    token: str,
    doc_id: str,
    files: list[dict[str, str]],
    folders: list[str] | None = None,
) -> Response:
    body: dict[str, Any] = {"files": files}
    if folders is not None:
        body["folders"] = folders
    return client.post(
        f"/api/tools/code/{doc_id}/snapshot",
        content=json.dumps(body).encode("utf-8"),
        headers=bearer(token),
    )


def project_dir(booted: Path, title_slug: str) -> Path:
    return next((booted / "docs").glob(f"{title_slug}-*"))


def test_a_new_project_starts_with_a_hello_file(
    client: TestClient, member_token: str, booted: Path
) -> None:
    doc_id = create_project(client, member_token, "Lessons")

    assert (project_dir(booted, "lessons") / "main.py").read_bytes() == b'print("Hello, world!")\n'
    detail = client.get(f"/api/documents/{doc_id}", headers=bearer(member_token)).json()
    assert [page["filename"] for page in detail["pages"]] == ["main.py"]


def test_a_snapshot_writes_the_tree_and_mirrors_pages(
    client: TestClient, member_token: str, booted: Path
) -> None:
    doc_id = create_project(client, member_token, "Lessons")

    response = push(
        client,
        member_token,
        doc_id,
        [
            {"path": "main.py", "text": "import util\n"},
            {"path": "src/util.py", "text": "VALUE = 1\n"},
        ],
        folders=["docs"],
    )

    assert response.status_code == 200, response.text
    doc_dir = project_dir(booted, "lessons")
    assert (doc_dir / "main.py").read_text(encoding="utf-8") == "import util\n"
    assert (doc_dir / "src" / "util.py").read_text(encoding="utf-8") == "VALUE = 1\n"
    assert (doc_dir / "docs").is_dir()

    detail = client.get(f"/api/documents/{doc_id}", headers=bearer(member_token)).json()
    assert [page["filename"] for page in detail["pages"]] == ["main.py", "src/util.py"]
    assert [page["title"] for page in detail["pages"]] == ["main.py", "src/util.py"]


def test_files_the_snapshot_drops_are_deleted_and_their_folders_pruned(
    client: TestClient, member_token: str, booted: Path
) -> None:
    doc_id = create_project(client, member_token, "Lessons")
    push(
        client,
        member_token,
        doc_id,
        [
            {"path": "main.py", "text": "one\n"},
            {"path": "src/util.py", "text": "two\n"},
        ],
    )

    response = push(client, member_token, doc_id, [{"path": "main.py", "text": "one\n"}])

    assert response.status_code == 200
    doc_dir = project_dir(booted, "lessons")
    assert not (doc_dir / "src").exists()
    # The deleted file's history is the undelete path, so it must survive.
    versions = client.get(f"/api/documents/{doc_id}/versions", headers=bearer(member_token)).json()
    assert any(entry["filename"] == "src/util.py" for entry in versions)


def test_a_nested_file_is_served_and_versioned_under_its_path(
    client: TestClient, member_token: str
) -> None:
    doc_id = create_project(client, member_token, "Lessons")
    push(client, member_token, doc_id, [{"path": "src/deep/util.py", "text": "x = 1\n"}])

    fetched = client.get(
        f"/api/documents/{doc_id}/files/src/deep/util.py", headers=bearer(member_token)
    )
    versions = client.get(f"/api/documents/{doc_id}/versions", headers=bearer(member_token)).json()
    entry = next(item for item in versions if item["filename"] == "src/deep/util.py")
    content = client.get(
        f"/api/documents/{doc_id}/versions/{entry['name']}", headers=bearer(member_token)
    )

    assert fetched.status_code == 200
    assert fetched.text == "x = 1\n"
    assert "src~deep~util.py" in entry["name"]
    assert content.status_code == 200
    assert content.text == "x = 1\n"


def test_an_unchanged_snapshot_writes_no_second_version(
    client: TestClient, member_token: str
) -> None:
    doc_id = create_project(client, member_token, "Lessons")
    files = [{"path": "main.py", "text": "steady\n"}]

    first = push(client, member_token, doc_id, files)
    second = push(client, member_token, doc_id, files)

    assert first.json() == {"version_written": True}
    assert second.json() == {"version_written": False}


def test_invalid_paths_are_refused(client: TestClient, member_token: str) -> None:
    doc_id = create_project(client, member_token, "Lessons")

    cases = [
        [{"path": "../escape.py", "text": ""}],
        [{"path": ".hidden/x.py", "text": ""}],
        [{"path": "a//b.py", "text": ""}],
        [{"path": "a/" + "b/" * 9 + "x.py", "text": ""}],
        [{"path": "x" * 65 + ".py", "text": ""}],
        [{"path": "main.py", "text": "a\x00b"}],
        [{"path": "main.py", "text": ""}, {"path": "main.py", "text": ""}],
    ]

    for files in cases:
        response = push(client, member_token, doc_id, files)
        assert response.status_code == 422, f"accepted: {files!r}"


def test_a_folder_may_not_shadow_a_file(client: TestClient, member_token: str) -> None:
    doc_id = create_project(client, member_token, "Lessons")

    response = push(
        client, member_token, doc_id, [{"path": "main.py", "text": ""}], folders=["main.py"]
    )

    assert response.status_code == 422


def test_the_file_count_ceiling_applies(
    client: TestClient, member_token: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    doc_id = create_project(client, member_token, "Lessons")
    monkeypatch.setenv("CODE_MAX_FILES", "2")
    get_settings.cache_clear()

    response = push(
        client,
        member_token,
        doc_id,
        [{"path": f"file-{index}.py", "text": ""} for index in range(3)],
    )

    assert response.status_code == 422


def test_the_file_size_ceiling_applies(
    client: TestClient, member_token: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    doc_id = create_project(client, member_token, "Lessons")
    monkeypatch.setenv("CODE_MAX_FILE_KB", "1")
    get_settings.cache_clear()

    response = push(client, member_token, doc_id, [{"path": "big.py", "text": "x" * 2048}])

    assert response.status_code == 422
