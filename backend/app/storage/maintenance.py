"""Background upkeep.

One task inside the backend process — no cron, no second program. Each pass purges
expired trash, prunes version history, takes the periodic database backup when one is
due, and drops expired sessions. A failing pass is logged and retried on the next tick
rather than taking the service down.
"""

import asyncio
import logging

from fastapi import FastAPI
from sqlalchemy import delete

from app.config import Settings, get_settings
from app.models import RefreshToken, now_iso
from app.storage import backups, trash, versions

logger = logging.getLogger(__name__)

PASS_INTERVAL_SECONDS = 3600


def _prune_all_versions(settings: Settings) -> None:
    if not settings.docs_dir.is_dir():
        return
    for entry in settings.docs_dir.iterdir():
        if entry.name.startswith(".") or not entry.is_dir():
            continue
        versions.prune_versions(entry, settings.versions_keep, settings.versions_days)


async def run_pass(app: FastAPI, settings: Settings) -> None:
    # The layout belongs to the boot sequence. If it is not there, report nothing to do
    # rather than conjuring directories beside a database that was never prepared.
    if not settings.data_dir.is_dir():
        return
    await asyncio.to_thread(trash.purge_expired, settings, settings.trash_days)
    await asyncio.to_thread(_prune_all_versions, settings)
    due = await asyncio.to_thread(
        backups.backup_due, settings.backups_dir, settings.backup_interval_hours
    )
    if due:
        await asyncio.to_thread(
            backups.write_backup,
            settings.database_path,
            settings.backups_dir,
            settings.backup_keep,
        )
    factory = app.state.sessions
    async with factory() as session:
        await session.execute(delete(RefreshToken).where(RefreshToken.expires_at <= now_iso()))
        await session.commit()
    app.state.login_limiter_by_username.sweep()
    app.state.login_limiter_by_ip.sweep()


async def maintenance_loop(app: FastAPI) -> None:
    settings = get_settings()
    while True:
        try:
            await run_pass(app, settings)
        except Exception:
            logger.exception("maintenance pass failed")
        await asyncio.sleep(PASS_INTERVAL_SECONDS)
