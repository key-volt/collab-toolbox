import sqlite3
from pathlib import Path

from app import boot


def test_boot_creates_the_data_tree(data_dir: Path) -> None:
    assert boot.main() == 0

    assert (data_dir / "docs" / ".trash").is_dir()
    assert (data_dir / "uploads").is_dir()
    assert (data_dir / "backups").is_dir()
    assert (data_dir / "app.sqlite").is_file()


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
