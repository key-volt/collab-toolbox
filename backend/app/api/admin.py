"""Administrator endpoints: accounts and the trash.

The administrator account itself is off limits here — its password comes from the secret
file, its flags are re-applied on every boot, and no API path may change or delete it.
"""

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from app.auth.deps import AdminUser, SessionDep
from app.auth.passwords import hash_password
from app.config import get_settings
from app.models import Document, Page, Upload, User
from app.storage import trash

router = APIRouter(prefix="/admin")


class CreateUserRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: str = Field(min_length=1, max_length=64, pattern=r"^\S+$")
    password: str = Field(min_length=8, max_length=1000)


class PatchUserRequest(BaseModel):
    # extra="forbid" is what rejects is_admin outright instead of silently ignoring it.
    model_config = ConfigDict(extra="forbid")

    is_whitelisted: bool


class AdminUserRow(BaseModel):
    id: str
    username: str
    is_admin: bool
    is_whitelisted: bool
    created_at: str


class TrashRow(BaseModel):
    name: str
    title: str
    tool: str
    deleted_at: str
    purge_after: str


def _row(user: User) -> AdminUserRow:
    return AdminUserRow(
        id=user.id,
        username=user.username,
        is_admin=user.is_admin,
        is_whitelisted=user.is_whitelisted,
        created_at=user.created_at,
    )


@router.get("/users")
async def list_users(_admin: AdminUser, session: SessionDep) -> list[AdminUserRow]:
    result = await session.execute(select(User).order_by(User.created_at, User.username))
    return [_row(user) for user in result.scalars()]


@router.post("/users", status_code=201)
async def create_user(
    body: CreateUserRequest, _admin: AdminUser, session: SessionDep
) -> AdminUserRow:
    existing = await session.execute(select(User).where(User.username == body.username))
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="username already exists")
    user = User(username=body.username, password_hash=hash_password(body.password))
    session.add(user)
    await session.commit()
    return _row(user)


@router.patch("/users/{user_id}")
async def patch_user(
    user_id: str, body: PatchUserRequest, _admin: AdminUser, request: Request, session: SessionDep
) -> AdminUserRow:
    user = await session.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="no such user")
    if user.is_admin:
        raise HTTPException(status_code=403, detail="the administrator account is file-managed")
    user.is_whitelisted = body.is_whitelisted
    await session.commit()
    if not body.is_whitelisted:
        await request.app.state.hub.kick_user(user.id)
    return _row(user)


@router.delete("/users/{user_id}")
async def delete_user(
    user_id: str, _admin: AdminUser, request: Request, session: SessionDep
) -> Response:
    user = await session.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="no such user")
    if user.is_admin:
        raise HTTPException(status_code=403, detail="the administrator account is file-managed")
    await session.delete(user)
    await session.commit()
    await request.app.state.hub.kick_user(user_id)
    return Response(status_code=204)


@router.get("/trash")
async def list_trash(_admin: AdminUser) -> list[TrashRow]:
    settings = get_settings()
    entries = await asyncio.to_thread(trash.list_trash, settings, settings.trash_days)
    return [
        TrashRow(
            name=entry.name,
            title=entry.title,
            tool=entry.tool,
            deleted_at=entry.deleted_at,
            purge_after=entry.purge_after,
        )
        for entry in entries
    ]


@router.post("/trash/{name}/restore")
async def restore_trash(name: str, _admin: AdminUser, session: SessionDep) -> Response:
    settings = get_settings()
    manifest = await asyncio.to_thread(trash.restore_from_trash, settings, name)
    if manifest is None:
        raise HTTPException(status_code=409, detail="cannot restore this entry")
    document: dict[str, Any] = manifest.get("document", {})
    session.add(
        Document(
            id=str(document["id"]),
            tool=str(document["tool"]),
            title=str(document["title"]),
            dir_name=str(document["dir_name"]),
            created_at=str(document["created_at"]),
        )
    )
    for page in manifest.get("pages", []):
        session.add(
            Page(
                id=str(page["id"]),
                document_id=str(page["document_id"]),
                ordinal=int(page["ordinal"]),
                title=str(page["title"]),
                filename=str(page["filename"]),
                page_index=None if page.get("page_index") is None else int(page["page_index"]),
            )
        )
    for upload in manifest.get("uploads", []):
        session.add(
            Upload(
                id=str(upload["id"]),
                document_id=str(upload["document_id"]),
                mime=str(upload["mime"]),
                bytes=int(upload["bytes"]),
                created_at=str(upload["created_at"]),
            )
        )
    await session.commit()
    return Response(status_code=204)
