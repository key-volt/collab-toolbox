"""Request authentication and authorization.

The token proves who is asking; what they may do is read from the database on every
request. That is what makes removing someone from the whitelist take effect on their
next request instead of when their token happens to expire.
"""

from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.auth.tokens import TokenError, read_access_token
from app.models import User


async def get_session(request: Request) -> AsyncIterator[AsyncSession]:
    factory: async_sessionmaker[AsyncSession] = request.app.state.sessions
    async with factory() as session:
        yield session


SessionDep = Annotated[AsyncSession, Depends(get_session)]


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(status_code=401, detail=detail, headers={"WWW-Authenticate": "Bearer"})


async def get_current_user(request: Request, session: SessionDep) -> User:
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise _unauthorized("missing bearer token")
    try:
        user_id = read_access_token(token.strip(), request.app.state.jwt_secret)
    except TokenError as exc:
        raise _unauthorized("invalid token") from exc
    user = await session.get(User, user_id)
    if user is None:
        raise _unauthorized("unknown account")
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


async def get_whitelisted_user(user: CurrentUser) -> User:
    if not user.is_whitelisted:
        raise HTTPException(status_code=403, detail="account is not whitelisted")
    return user


WhitelistedUser = Annotated[User, Depends(get_whitelisted_user)]


async def get_admin_user(user: CurrentUser) -> User:
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="administrator only")
    return user


AdminUser = Annotated[User, Depends(get_admin_user)]
