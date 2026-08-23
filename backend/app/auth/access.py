"""Who may do what with a document.

Administrators and the owner manage; a grant row gives read or edit; everyone else
has nothing. Levels are strictly ordered, so "at least edit" is one comparison. The
level is read from the database on every check — that is what makes a revocation act
on the next request instead of when a token expires.
"""

from typing import Literal

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Document, DocumentAccess, User

AccessLevel = Literal["none", "read", "edit", "manage"]

_ORDER: dict[str, int] = {"none": 0, "read": 1, "edit": 2, "manage": 3}


def satisfies(level: AccessLevel, needed: AccessLevel) -> bool:
    return _ORDER[level] >= _ORDER[needed]


async def access_level(session: AsyncSession, user: User, document: Document) -> AccessLevel:
    if user.is_admin or document.owner_id == user.id:
        return "manage"
    grant = await session.get(DocumentAccess, (document.id, user.id))
    if grant is None:
        return "none"
    return "edit" if grant.level == "edit" else "read"


async def require_access(
    session: AsyncSession, user: User, document: Document, needed: AccessLevel
) -> AccessLevel:
    level = await access_level(session, user, document)
    if not satisfies(level, needed):
        raise HTTPException(status_code=403, detail="no access to this document")
    return level
