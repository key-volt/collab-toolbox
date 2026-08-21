"""Migration entry point.

SQLite cannot alter a column in place, so every migration runs in batch mode, which
rebuilds the affected table. The database location comes from the application settings
unless a URL was set explicitly on the config.
"""

from alembic import context
from sqlalchemy import create_engine, pool

from app.config import get_settings
from app.models import Base

target_metadata = Base.metadata


def database_url() -> str:
    configured = context.config.get_main_option("sqlalchemy.url")
    if configured:
        return configured
    return f"sqlite:///{get_settings().database_path}"


def run_migrations_offline() -> None:
    context.configure(
        url=database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        render_as_batch=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = create_engine(database_url(), poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=True,
        )
        with context.begin_transaction():
            context.run_migrations()
    engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
