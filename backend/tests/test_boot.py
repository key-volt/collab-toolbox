import sqlite3
from pathlib import Path

import pytest

from app import boot
from app.auth.passwords import verify_password
from tests.conftest import ADMIN_PASSWORD


def test_boot_creates_the_data_tree(data_dir: Path) -> None:
    assert boot.main() == 0

    assert (data_dir / "docs" / ".trash").is_dir()
    assert (data_dir / "uploads").is_dir()
    assert (data_dir / "backups").is_dir()
    assert (data_dir / "app.sqlite").is_file()


def test_boot_migrates_and_applies_the_admin(data_dir: Path) -> None:
    assert boot.main() == 0

    connection = sqlite3.connect(data_dir / "app.sqlite")
    try:
        row = connection.execute(
            "SELECT password_hash, is_admin, is_whitelisted FROM users WHERE username = 'admin'"
        ).fetchone()
    finally:
        connection.close()

    assert row is not None
    password_hash, is_admin, is_whitelisted = row
    assert is_admin == 1
    assert is_whitelisted == 1
    assert verify_password(password_hash, ADMIN_PASSWORD)


def test_boot_resets_the_admin_password_every_run(data_dir: Path) -> None:
    assert boot.main() == 0
    connection = sqlite3.connect(data_dir / "app.sqlite")
    try:
        connection.execute("UPDATE users SET password_hash = 'tampered' WHERE username = 'admin'")
        connection.commit()
    finally:
        connection.close()

    assert boot.main() == 0

    connection = sqlite3.connect(data_dir / "app.sqlite")
    try:
        stored = connection.execute(
            "SELECT password_hash FROM users WHERE username = 'admin'"
        ).fetchone()[0]
    finally:
        connection.close()
    assert verify_password(stored, ADMIN_PASSWORD)


def test_boot_refuses_without_the_admin_secret(data_dir: Path) -> None:
    from app.config import get_settings

    (get_settings().secrets_dir / "admin_password").unlink()

    assert boot.main() == 1


def test_boot_refuses_a_snapshot_ceiling_above_the_upload_ceiling(
    data_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.config import get_settings

    monkeypatch.setenv("CODE_MAX_PROJECT_MB", "30")
    monkeypatch.setenv("UPLOAD_MAX_MB", "25")
    get_settings.cache_clear()

    assert boot.main() == 1


def test_boot_leaves_the_database_in_wal_mode(data_dir: Path) -> None:
    boot.main()

    connection = sqlite3.connect(data_dir / "app.sqlite")
    try:
        mode = connection.execute("PRAGMA journal_mode").fetchone()[0]
    finally:
        connection.close()

    assert mode == "wal"


def test_boot_copies_an_existing_database_aside(data_dir: Path) -> None:
    boot.main()
    connection = sqlite3.connect(data_dir / "app.sqlite")
    try:
        connection.execute("CREATE TABLE marker (id INTEGER PRIMARY KEY)")
        connection.commit()
    finally:
        connection.close()

    assert boot.main() == 0

    copies = list((data_dir / "backups").glob("pre-migrate-*.sqlite"))
    assert len(copies) == 1

    copy = sqlite3.connect(copies[0])
    try:
        names = {row[0] for row in copy.execute("SELECT name FROM sqlite_master")}
    finally:
        copy.close()

    assert "marker" in names


def test_boot_writes_no_copy_on_a_first_run(data_dir: Path) -> None:
    assert boot.main() == 0

    assert list((data_dir / "backups").glob("pre-migrate-*.sqlite")) == []
