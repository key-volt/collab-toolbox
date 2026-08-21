"""Documents: the layout index over the files on disk.

Every whitelisted user sees and edits every document; only the administrator deletes,
and deletion is a move to the trash, not destruction. Content bytes are served and
accepted here without interpretation — parsing happens only to mirror page lists.
"""

import asyncio

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import AdminUser, SessionDep, WhitelistedUser
from app.config import get_settings
from app.models import Document, Page, Upload
from app.storage import docs, trash, versions
from app.tools.registry import get_tool

router = APIRouter(prefix="/documents")

_CONTENT_HEADERS = {
    "Content-Disposition": "attachment",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "X-Content-Type-Options": "nosniff",
}


class CreateDocumentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tool: str = Field(min_length=1, max_length=64)
    title: str = Field(min_length=1, max_length=200)


class RenameDocumentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=200)


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


class DocumentDetail(BaseModel):
    id: str
    tool: str
    title: str
    created_at: str
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
    _user: WhitelistedUser, session: SessionDep, tool: str | None = None
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
    counts = dict(counts_result.all())

    rows = []
    for document in documents:
        modified = await asyncio.to_thread(docs.modified_at, settings, document.dir_name)
        rows.append(
            DocumentRow(
                id=document.id,
                tool=document.tool,
                title=document.title,
                created_at=document.created_at,
                modified_at=modified,
                page_count=int(counts.get(document.id, 0)),
            )
        )
    return rows


@router.post("", status_code=201)
async def create_document(
    body: CreateDocumentRequest, _user: WhitelistedUser, session: SessionDep
) -> DocumentDetail:
    tool = get_tool(body.tool)
    if tool is None:
        raise HTTPException(status_code=422, detail="unknown tool")
    settings = get_settings()
    document = Document(tool=tool.slug, title=body.title.strip())
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
async def read_document(doc_id: str, _user: WhitelistedUser, session: SessionDep) -> DocumentDetail:
    document = await _get_document(session, doc_id)
    result = await session.execute(
        select(Page).where(Page.document_id == doc_id).order_by(Page.ordinal)
    )
    return DocumentDetail(
        id=document.id,
        tool=document.tool,
        title=document.title,
        created_at=document.created_at,
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
    doc_id: str, body: RenameDocumentRequest, _user: WhitelistedUser, session: SessionDep
) -> DocumentDetail:
    document = await _get_document(session, doc_id)
    document.title = body.title.strip()
    await session.commit()
    return await read_document(doc_id, _user, session)


@router.delete("/{doc_id}")
async def delete_document(doc_id: str, _admin: AdminUser, session: SessionDep) -> Response:
    settings = get_settings()
    document = await _get_document(session, doc_id)
    pages_result = await session.execute(select(Page).where(Page.document_id == doc_id))
    uploads_result = await session.execute(select(Upload).where(Upload.document_id == doc_id))
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
    document_row = {
        "id": document.id,
        "tool": document.tool,
        "title": document.title,
        "dir_name": document.dir_name,
        "created_at": document.created_at,
    }
    await asyncio.to_thread(
        trash.move_to_trash, settings, document.dir_name, document_row, page_rows, upload_rows
    )
    await session.delete(document)
    await session.commit()
    return Response(status_code=204)


@router.get("/{doc_id}/files/{filename}")
async def read_document_file(
    doc_id: str, filename: str, _user: WhitelistedUser, session: SessionDep
) -> Response:
    document = await _get_document(session, doc_id)
    result = await session.execute(
        select(Page.filename).where(Page.document_id == doc_id).distinct()
    )
    known = {row for (row,) in result.all()}
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
    doc_id: str, _user: WhitelistedUser, session: SessionDep
) -> list[VersionRow]:
    document = await _get_document(session, doc_id)
    doc_dir = docs.document_dir(get_settings(), document.dir_name)
    found = await asyncio.to_thread(versions.list_versions, doc_dir)
    return [
        VersionRow(name=info.name, filename=info.filename, stamp=info.stamp, size=info.size)
        for info in found
    ]


@router.get("/{doc_id}/versions/{name}")
async def read_document_version(
    doc_id: str, name: str, _user: WhitelistedUser, session: SessionDep
) -> Response:
    document = await _get_document(session, doc_id)
    doc_dir = docs.document_dir(get_settings(), document.dir_name)
    content = await asyncio.to_thread(versions.read_version, doc_dir, name)
    if content is None:
        raise HTTPException(status_code=404, detail="no such version")
    return Response(content, media_type="application/octet-stream", headers=_CONTENT_HEADERS)
