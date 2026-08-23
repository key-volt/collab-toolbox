"""The tool manifest and the snapshot push.

Persistence is client-driven: one elected client serializes the live document and posts
it here. The push is validated — parsed, right root, under the size cap — because a
whitelisted sender does not make the bytes trustworthy, then written to disk with a
version entry when the content actually changed, and the page mirror is reconciled by
plain parsing.
"""

import asyncio

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import delete, select

from app.auth.access import require_access
from app.auth.deps import SessionDep, WhitelistedUser
from app.config import get_settings
from app.models import Document, Page
from app.storage import docs, versions
from app.tools.base import SnapshotError
from app.tools.registry import TOOLS, get_tool

router = APIRouter(prefix="/tools")


class ToolRow(BaseModel):
    slug: str
    title: str


class ToolsInfo(BaseModel):
    tools: list[ToolRow]
    # Clients run the snapshot loop, so the interval travels with the manifest.
    autosave_seconds: int


class SnapshotResult(BaseModel):
    version_written: bool


@router.get("")
async def list_tools(_user: WhitelistedUser) -> ToolsInfo:
    return ToolsInfo(
        tools=[ToolRow(slug=tool.slug, title=tool.title) for tool in TOOLS],
        autosave_seconds=get_settings().autosave_seconds,
    )


@router.post("/{slug}/{doc_id}/snapshot")
async def push_snapshot(
    slug: str, doc_id: str, request: Request, user: WhitelistedUser, session: SessionDep
) -> SnapshotResult:
    tool = get_tool(slug)
    if tool is None:
        raise HTTPException(status_code=404, detail="no such tool")
    document = await session.get(Document, doc_id)
    if document is None or document.tool != slug:
        raise HTTPException(status_code=404, detail="no such document")
    await require_access(session, user, document, "edit")

    settings = get_settings()
    cap = settings.upload_max_mb * 1024 * 1024
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > cap:
        raise HTTPException(status_code=413, detail="snapshot is larger than the limit")
    body = await request.body()
    if len(body) > cap:
        raise HTTPException(status_code=413, detail="snapshot is larger than the limit")

    try:
        snapshot = tool.parse_snapshot(body)
    except SnapshotError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    doc_dir = docs.document_dir(settings, document.dir_name)
    version_written = False
    for filename, content in snapshot.files.items():
        wrote = await asyncio.to_thread(
            versions.write_snapshot,
            doc_dir,
            filename,
            content,
            settings.versions_keep,
            settings.versions_days,
        )
        version_written = version_written or wrote
    if tool.sync_tree:
        await asyncio.to_thread(
            docs.sync_tree,
            settings,
            document.dir_name,
            set(snapshot.files),
            set(snapshot.folders),
        )

    existing = await session.execute(
        select(Page).where(Page.document_id == doc_id).order_by(Page.ordinal)
    )
    current = [
        (page.ordinal, page.title, page.filename, page.page_index) for page in existing.scalars()
    ]
    wanted = [(spec.ordinal, spec.title, spec.filename, spec.page_index) for spec in snapshot.pages]
    if current != wanted:
        await session.execute(delete(Page).where(Page.document_id == doc_id))
        session.add_all(
            Page(
                document_id=doc_id,
                ordinal=spec.ordinal,
                title=spec.title,
                filename=spec.filename,
                page_index=spec.page_index,
            )
            for spec in snapshot.pages
        )
    await session.commit()
    return SnapshotResult(version_written=version_written)
