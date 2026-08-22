"""Runtime configuration.

Values come from the environment. Credentials never do — they are files mounted into the
container and are read at the point of use, not held here.
"""

from functools import lru_cache
from pathlib import Path
from typing import ClassVar, Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config: ClassVar[SettingsConfigDict] = SettingsConfigDict(
        extra="ignore", case_sensitive=False
    )

    data_dir: Path = Path("/data")
    secrets_dir: Path = Path("/run/secrets")

    domain: str = "localhost"
    tls_mode: Literal["acme", "off"] = "acme"

    admin_username: str = "admin"

    autosave_seconds: int = Field(default=10, ge=1)
    access_ttl: int = Field(default=600, ge=60)
    refresh_ttl: int = Field(default=2_592_000, ge=3600)

    versions_keep: int = Field(default=50, ge=1)
    versions_days: int = Field(default=30, ge=1)
    trash_days: int = Field(default=30, ge=1)

    backup_interval_hours: int = Field(default=24, ge=1)
    backup_keep: int = Field(default=14, ge=1)

    upload_max_mb: int = Field(default=25, ge=1)

    registration_enabled: bool = True
    registration_pending_max: int = Field(default=20, ge=1)

    code_max_files: int = Field(default=200, ge=1)
    code_max_file_kb: int = Field(default=512, ge=1)
    code_max_project_mb: int = Field(default=20, ge=1)

    def read_secret(self, name: str) -> str:
        """Read a credential file mounted into the container.

        The value is stripped: secret files are routinely created with a trailing newline
        (``openssl rand -hex 32 > file`` leaves one), and a signing key or password compared
        with that newline attached fails with nothing useful in the log.
        """
        path = self.secrets_dir / name
        try:
            value = path.read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise RuntimeError(f"secret file {path} is not readable: {exc}") from exc
        if not value:
            raise RuntimeError(f"secret file {path} is empty")
        return value

    @property
    def database_path(self) -> Path:
        return self.data_dir / "app.sqlite"

    @property
    def docs_dir(self) -> Path:
        return self.data_dir / "docs"

    @property
    def trash_dir(self) -> Path:
        return self.docs_dir / ".trash"

    @property
    def uploads_dir(self) -> Path:
        return self.data_dir / "uploads"

    @property
    def backups_dir(self) -> Path:
        return self.data_dir / "backups"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
