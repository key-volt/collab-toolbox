"""Uploaded images, stored outside documents and served only through authorization.

A static path would make the URL itself the permission — readable forever by anyone it
leaked to. Here every byte is streamed after a fresh session and whitelist check, so
revoking an account also cuts off its images.
"""

import asyncio
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from app.auth.access import require_access
from app.auth.deps import SessionDep, WhitelistedUser
from app.config import get_settings
from app.models import Document, Upload, new_id
from app.storage import uploads

router = APIRouter(prefix="/files")

_SERVE_HEADERS = {
    "Content-Disposition": "attachment",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "X-Content-Type-Options": "nosniff",
}


@router.post("", status_code=201)
async def upload_file(
    user: WhitelistedUser,
    session: SessionDep,
    file: Annotated[UploadFile, File()],
    document_id: Annotated[str | None, Form()] = None,
) -> dict[str, str]:
    settings = get_settings()
    cap = settings.upload_max_mb * 1024 * 1024
    content = await file.read(cap + 1)
    if len(content) > cap:
        raise HTTPException(status_code=413, detail="file is larger than the configured limit")
    if not content:
        raise HTTPException(status_code=422, detail="file is empty")
    mime = uploads.sniff_mime(content)
    if mime is None:
        raise HTTPException(status_code=415, detail="file type is not supported")
    if document_id is not None:
        document = await session.get(Document, document_id)
        if document is None:
            raise HTTPException(status_code=404, detail="no such document")
        await require_access(session, user, document, "edit")
    # The id is the filename on disk and is used before the first flush, so it cannot
    # come from the column default.
    row = Upload(id=new_id(), document_id=document_id, mime=mime, bytes=len(content))
    await asyncio.to_thread(uploads.save_upload, settings.uploads_dir, row.id, content)
    session.add(row)
    await session.commit()
    return {"id": row.id, "mime": mime}


@router.get("/{file_id}")
async def read_file(file_id: str, user: WhitelistedUser, session: SessionDep) -> FileResponse:
    row = await session.get(Upload, file_id)
    if row is None:
        raise HTTPException(status_code=404, detail="no such file")
    if row.document_id is not None:
        document = await session.get(Document, row.document_id)
        if document is not None:
            await require_access(session, user, document, "read")
    path = get_settings().uploads_dir / row.id
    if not path.is_file():
        raise HTTPException(status_code=404, detail="no such file")
    return FileResponse(path, media_type=row.mime, headers=_SERVE_HEADERS)
