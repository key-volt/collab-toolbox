"""The administrator account.

There is exactly one, defined entirely by the secret file and re-asserted on every boot.
Nothing else ever writes the admin flag, so a restart can only ever touch this row.
"""

import sqlite3

from app.auth.passwords import hash_password
from app.config import Settings
from app.models import new_id, now_iso

UPSERT = """
INSERT INTO users (id, username, password_hash, is_admin, is_whitelisted, created_at)
VALUES (?, ?, ?, 1, 1, ?)
ON CONFLICT (username)
DO UPDATE SET password_hash = excluded.password_hash, is_admin = 1, is_whitelisted = 1
"""


def apply_admin(settings: Settings) -> str:
    """Create or reset the admin account from the secret file. Returns the username."""
    password = settings.read_secret("admin_password")
    password_hash = hash_password(password)
    connection = sqlite3.connect(settings.database_path)
    try:
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute(UPSERT, (new_id(), settings.admin_username, password_hash, now_iso()))
        # Belt and braces: even a hand-edited database ends up with a single administrator.
        connection.execute(
            "UPDATE users SET is_admin = 0 WHERE username <> ?", (settings.admin_username,)
        )
        connection.commit()
    finally:
        connection.close()
    return settings.admin_username
