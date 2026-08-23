"""Documents: the layout index over the files on disk.

Every document's name is listed for every whitelisted user, but content is gated per
document: reading needs a read grant, changing needs an edit grant, and the owner or
an administrator manages grants and the document's lifecycle. Deletion is a move to
the trash, not destruction. Content bytes are served and accepted here without
interpretation — parsing happens only to mirror page lists.
"""

import asyncio
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.access import AccessLevel, require_access
from app.auth.deps import SessionDep, WhitelistedUser
from app.config import get_settings
from app.models import Document, DocumentAccess, Page, Upload, User, new_id
from app.storage import docs, trash, versions
from app.tools.registry import get_tool

router = APIRouter(prefix="/documents")

_CONTENT_HEADERS = {
    "Content-Disposition": "attachment",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "X-Content-Type-Options": "nosniff",
}

GrantLevel = Literal["read", "edit"]


class CreateDocumentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tool: str = Field(min_length=1, max_length=64)
    title: str = Field(min_length=1, max_length=200)


class RenameDocumentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=200)


class GrantEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_id: str
    level: GrantLevel


class ReplaceAccessRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    entries: list[GrantEntry]


class AccessUserRow(BaseModel):
    user_id: str
    username: str
    level: GrantLevel


class CandidateRow(BaseModel):
    id: str
    username: str


class AccessInfo(BaseModel):
    owner: str | None
    entries: list[AccessUserRow]
    # Every account a grant could name: whitelisted, not an administrator, not the
    # owner. Administrators and the owner always have access and are never listed.
    candidates: list[CandidateRow]


class PageRow(BaseModel):
    id: str
    ordinal: int
    title: str
    filename: str
    page_index: int | None


class DocumentRow(BaseModel):
    id: str
    tool: str
    title: str
    created_at: str
    modified_at: str | None
    page_count: int
    access: AccessLevel
    owner: str | None


class DocumentDetail(BaseModel):
    id: str
    tool: str
    title: str
    created_at: str
    access: AccessLevel
    pages: list[PageRow]


class VersionRow(BaseModel):
    name: str
    filename: str
    stamp: str
    size: int


async def _get_document(session: AsyncSession, doc_id: str) -> Document:
    document = await session.get(Document, doc_id)
    if document is None:
        raise HTTPException(status_code=404, detail="no such document")
    return document


@router.get("")
async def list_documents(
    user: WhitelistedUser, session: SessionDep, tool: str | None = None
) -> list[DocumentRow]:
    settings = get_settings()
    query = select(Document).order_by(Document.created_at.desc())
    if tool is not None:
        query = query.where(Document.tool == tool)
    result = await session.execute(query)
    documents = list(result.scalars())

    counts_result = await session.execute(
        select(Page.document_id, func.count()).group_by(Page.document_id)
    )
    counts = dict(counts_result.tuples().all())

    grants_result = await session.execute(
        select(DocumentAccess.document_id, DocumentAccess.level).where(
            DocumentAccess.user_id == user.id
        )
    )
    grants = dict(grants_result.tuples().all())

    owner_ids = {document.owner_id for document in documents if document.owner_id is not None}
    owners: dict[str, str] = {}
    if owner_ids:
        owners_result = await session.execute(
            select(User.id, User.username).where(User.id.in_(owner_ids))
        )
        owners = dict(owners_result.tuples().all())

    rows = []
    for document in documents:
        if user.is_admin or document.owner_id == user.id:
            level: AccessLevel = "manage"
        elif grants.get(document.id) == "edit":
            level = "edit"
        elif grants.get(document.id) == "read":
            level = "read"
        else:
            level = "none"
        modified = await asyncio.to_thread(docs.modified_at, settings, document.dir_name)
        rows.append(
            DocumentRow(
                id=document.id,
                tool=document.tool,
                title=document.title,
                created_at=document.created_at,
                modified_at=modified,
                page_count=int(counts.get(document.id, 0)),
                access=level,
                owner=None if document.owner_id is None else owners.get(document.owner_id),
            )
        )
    return rows


@router.post("", status_code=201)
async def create_document(
    body: CreateDocumentRequest, user: WhitelistedUser, session: SessionDep
) -> DocumentDetail:
    tool = get_tool(body.tool)
    if tool is None:
        raise HTTPException(status_code=422, detail="unknown tool")
    settings = get_settings()
    # The id is needed before the first flush (the folder name embeds it), so it cannot
    # come from the column default.
    document = Document(id=new_id(), tool=tool.slug, title=body.title.strip(), owner_id=user.id)
    document.dir_name = docs.dir_name_for(document.title, document.id)
    await asyncio.to_thread(
        docs.create_document_dir, settings, document.dir_name, tool.initial_files()
    )
    session.add(document)
    pages = [
        Page(
            document_id=document.id,
            ordinal=spec.ordinal,
            title=spec.title,
            filename=spec.filename,
            page_index=spec.page_index,
        )
        for spec in tool.initial_pages()
    ]
    session.add_all(pages)
    await session.commit()
    return DocumentDetail(
        id=document.id,
        tool=document.tool,
        title=document.title,
        created_at=document.created_at,
        access="manage",
        pages=[
            PageRow(
                id=page.id,
                ordinal=page.ordinal,
                title=page.title,
                filename=page.filename,
                page_index=page.page_index,
            )
            for page in pages
        ],
    )


@router.get("/{doc_id}")
async def read_document(doc_id: str, user: WhitelistedUser, session: SessionDep) -> DocumentDetail:
    document = await _get_document(session, doc_id)
    level = await require_access(session, user, document, "read")
    result = await session.execute(
        select(Page).where(Page.document_id == doc_id).order_by(Page.ordinal)
    )
    return DocumentDetail(
        id=document.id,
        tool=document.tool,
        title=document.title,
        created_at=document.created_at,
        access=level,
        pages=[
            PageRow(
                id=page.id,
                ordinal=page.ordinal,
                title=page.title,
                filename=page.filename,
                page_index=page.page_index,
            )
            for page in result.scalars()
        ],
    )


@router.patch("/{doc_id}")
async def rename_document(
    doc_id: str, body: RenameDocumentRequest, user: WhitelistedUser, session: SessionDep
) -> DocumentDetail:
    document = await _get_document(session, doc_id)
    await require_access(session, user, document, "manage")
    document.title = body.title.strip()
    await session.commit()
    return await read_document(doc_id, user, session)


@router.delete("/{doc_id}")
async def delete_document(
    doc_id: str, user: WhitelistedUser, request: Request, session: SessionDep
) -> Response:
    settings = get_settings()
    document = await _get_document(session, doc_id)
    await require_access(session, user, document, "manage")
    pages_result = await session.execute(select(Page).where(Page.document_id == doc_id))
    uploads_result = await session.execute(select(Upload).where(Upload.document_id == doc_id))
    grants_result = await session.execute(
        select(DocumentAccess).where(DocumentAccess.document_id == doc_id)
    )
    page_rows = [
        {
            "id": page.id,
            "document_id": page.document_id,
            "ordinal": page.ordinal,
            "title": page.title,
            "filename": page.filename,
            "page_index": page.page_index,
        }
        for page in pages_result.scalars()
    ]
    upload_rows = [
        {
            "id": upload.id,
            "document_id": upload.document_id,
            "mime": upload.mime,
            "bytes": upload.bytes,
            "created_at": upload.created_at,
        }
        for upload in uploads_result.scalars()
    ]
    access_rows = [
        {"document_id": grant.document_id, "user_id": grant.user_id, "level": grant.level}
        for grant in grants_result.scalars()
    ]
    document_row = {
        "id": document.id,
        "tool": document.tool,
        "title": document.title,
        "dir_name": document.dir_name,
        "created_at": document.created_at,
        "owner_id": document.owner_id,
    }
    await asyncio.to_thread(
        trash.move_to_trash,
        settings,
        document.dir_name,
        document_row,
        page_rows,
        upload_rows,
        access_rows,
    )
    await session.delete(document)
    await session.commit()
    # Everyone in the document's room is cut off right away — the document is gone.
    await request.app.state.hub.kick_document(doc_id)
    return Response(status_code=204)


async def _access_info(session: AsyncSession, document: Document) -> AccessInfo:
    owner_name: str | None = None
    if document.owner_id is not None:
        owner = await session.get(User, document.owner_id)
        owner_name = None if owner is None else owner.username
    grants_result = await session.execute(
        select(DocumentAccess.user_id, DocumentAccess.level, User.username)
        .join(User, User.id == DocumentAccess.user_id)
        .where(DocumentAccess.document_id == document.id)
        .order_by(User.username)
    )
    entries = [
        AccessUserRow(
            user_id=user_id, username=username, level="edit" if level == "edit" else "read"
        )
        for user_id, level, username in grants_result.tuples()
    ]
    candidates_result = await session.execute(
        select(User)
        .where(User.is_whitelisted.is_(True), User.is_admin.is_(False))
        .order_by(User.username)
    )
    candidates = [
        CandidateRow(id=candidate.id, username=candidate.username)
        for candidate in candidates_result.scalars()
        if candidate.id != document.owner_id
    ]
    return AccessInfo(owner=owner_name, entries=entries, candidates=candidates)


@router.get("/{doc_id}/access")
async def read_document_access(
    doc_id: str, user: WhitelistedUser, session: SessionDep
) -> AccessInfo:
    document = await _get_document(session, doc_id)
    await require_access(session, user, document, "manage")
    return await _access_info(session, document)


@router.put("/{doc_id}/access")
async def replace_document_access(
    doc_id: str,
    body: ReplaceAccessRequest,
    user: WhitelistedUser,
    request: Request,
    session: SessionDep,
) -> AccessInfo:
    document = await _get_document(session, doc_id)
    await require_access(session, user, document, "manage")

    wanted: dict[str, GrantLevel] = {}
    for entry in body.entries:
        wanted[entry.user_id] = entry.level
    if wanted:
        named_result = await session.execute(select(User).where(User.id.in_(wanted)))
        named = {candidate.id: candidate for candidate in named_result.scalars()}
        for user_id in wanted:
            candidate = named.get(user_id)
            if candidate is None or not candidate.is_whitelisted:
                raise HTTPException(status_code=422, detail="grants must name approved accounts")
            if candidate.is_admin or candidate.id == document.owner_id:
                raise HTTPException(
                    status_code=422, detail="administrators and the owner always have access"
                )

    before_result = await session.execute(
        select(DocumentAccess).where(DocumentAccess.document_id == doc_id)
    )
    before: dict[str, str] = {}
    for grant in before_result.scalars():
        before[grant.user_id] = grant.level
        await session.delete(grant)
    for user_id, level in wanted.items():
        session.add(DocumentAccess(document_id=doc_id, user_id=user_id, level=level))
    await session.commit()

    # Anyone whose level dropped is cut off immediately, mid-edit included. They can
    # reopen the document if some access remains; the socket they held assumed the old
    # level. The commit lands first so a rejoin sees the new grants.
    hub = request.app.state.hub
    order = {"read": 1, "edit": 2}
    for user_id, had in before.items():
        now = wanted.get(user_id)
        if now is None or order[now] < order.get(had, 1):
            await hub.kick_user_from_document(user_id, doc_id)

    return await _access_info(session, document)


@router.get("/{doc_id}/files/{filename:path}")
async def read_document_file(
    doc_id: str, filename: str, user: WhitelistedUser, session: SessionDep
) -> Response:
    # The path converter lets code files live in subfolders. Traversal is impossible:
    # the name must exactly match a pages row, and those come from validated snapshots.
    document = await _get_document(session, doc_id)
    await require_access(session, user, document, "read")
    result = await session.execute(
        select(Page.filename).where(Page.document_id == doc_id).distinct()
    )
    known = set(result.scalars().all())
    if filename not in known:
        raise HTTPException(status_code=404, detail="no such file")
    try:
        content = await asyncio.to_thread(
            docs.read_document_file, get_settings(), document.dir_name, filename
        )
    except OSError as exc:
        raise HTTPException(status_code=404, detail="no such file") from exc
    return Response(content, media_type="application/octet-stream", headers=_CONTENT_HEADERS)


@router.get("/{doc_id}/versions")
async def list_document_versions(
    doc_id: str, user: WhitelistedUser, session: SessionDep
) -> list[VersionRow]:
    document = await _get_document(session, doc_id)
    await require_access(session, user, document, "read")
    doc_dir = docs.document_dir(get_settings(), document.dir_name)
    found = await asyncio.to_thread(versions.list_versions, doc_dir)
    return [
        VersionRow(name=info.name, filename=info.filename, stamp=info.stamp, size=info.size)
        for info in found
    ]


@router.get("/{doc_id}/versions/{name}")
async def read_document_version(
    doc_id: str, name: str, user: WhitelistedUser, session: SessionDep
) -> Response:
    document = await _get_document(session, doc_id)
    await require_access(session, user, document, "read")
    doc_dir = docs.document_dir(get_settings(), document.dir_name)
    content = await asyncio.to_thread(versions.read_version, doc_dir, name)
    if content is None:
        raise HTTPException(status_code=404, detail="no such version")
    return Response(content, media_type="application/octet-stream", headers=_CONTENT_HEADERS)
