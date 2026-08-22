"""Login, self-registration, session refresh, logout and password change.

The access token lives in the client's memory only. The refresh token is an httpOnly
cookie scoped under /api/auth, so scripts can never read it and it only ever travels to
these endpoints. The unauthenticated surface is login plus the registration pair; a
freshly registered account is signed in but sees nothing until it is approved.
"""

from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select

from app.auth.deps import CurrentUser, SessionDep
from app.auth.passwords import hash_password, verify_password
from app.auth.ratelimit import SlidingWindowLimiter
from app.auth.registration import new_challenge, payload_is_valid, username_error
from app.auth.tokens import (
    hash_refresh_token,
    issue_access_token,
    new_refresh_token,
)
from app.config import get_settings
from app.models import RefreshToken, User, now_iso

router = APIRouter(prefix="/auth")

REFRESH_COOKIE = "refresh_token"
REFRESH_COOKIE_PATH = "/api/auth"

# Verified against a wrong password when the username does not exist, so both failure
# paths cost a hash comparison and response timing does not reveal which usernames exist.
_DUMMY_HASH = hash_password("placeholder")


class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=1, max_length=1000)


class PasswordChangeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    current_password: str = Field(min_length=1, max_length=1000)
    new_password: str = Field(min_length=8, max_length=1000)


class RegisterRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=8, max_length=128)
    # The solved proof-of-work payload the captcha widget produced.
    altcha: str = Field(min_length=1, max_length=4096)


class SessionUser(BaseModel):
    id: str
    username: str
    is_admin: bool
    is_whitelisted: bool


class SessionResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"  # noqa: S105
    expires_in: int
    user: SessionUser


def _session_user(user: User) -> SessionUser:
    return SessionUser(
        id=user.id,
        username=user.username,
        is_admin=user.is_admin,
        is_whitelisted=user.is_whitelisted,
    )


def _session_response(user: User, jwt_secret: str, access_ttl: int) -> SessionResponse:
    return SessionResponse(
        access_token=issue_access_token(user.id, jwt_secret, access_ttl),
        expires_in=access_ttl,
        user=_session_user(user),
    )


def _cookie_secure(request: Request) -> bool:
    return request.url.scheme == "https"


def _set_refresh_cookie(response: Response, request: Request, token: str, max_age: int) -> None:
    response.set_cookie(
        REFRESH_COOKIE,
        token,
        max_age=max_age,
        path=REFRESH_COOKIE_PATH,
        httponly=True,
        secure=_cookie_secure(request),
        samesite="strict",
    )


def _clear_refresh_cookie(response: Response, request: Request) -> None:
    response.delete_cookie(
        REFRESH_COOKIE,
        path=REFRESH_COOKIE_PATH,
        httponly=True,
        secure=_cookie_secure(request),
        samesite="strict",
    )


def _expiry(seconds: int) -> str:
    return (datetime.now(UTC) + timedelta(seconds=seconds)).strftime("%Y-%m-%dT%H:%M:%SZ")


async def _open_session(
    user: User, request: Request, response: Response, session: SessionDep
) -> SessionResponse:
    """Persist a refresh token, set its cookie, and answer with a fresh access token."""
    settings = get_settings()
    refresh_token = new_refresh_token()
    session.add(
        RefreshToken(
            user_id=user.id,
            token_hash=hash_refresh_token(refresh_token),
            expires_at=_expiry(settings.refresh_ttl),
        )
    )
    await session.commit()
    _set_refresh_cookie(response, request, refresh_token, settings.refresh_ttl)
    return _session_response(user, request.app.state.jwt_secret, settings.access_ttl)


@router.post("/login")
async def login(
    body: LoginRequest, request: Request, response: Response, session: SessionDep
) -> SessionResponse:
    by_username: SlidingWindowLimiter = request.app.state.login_limiter_by_username
    by_ip: SlidingWindowLimiter = request.app.state.login_limiter_by_ip
    client_ip = request.client.host if request.client else "unknown"
    if not by_ip.allow(client_ip) or not by_username.allow(body.username.lower()):
        raise HTTPException(status_code=429, detail="too many login attempts, try again shortly")

    result = await session.execute(select(User).where(User.username == body.username))
    user = result.scalar_one_or_none()
    if user is None:
        verify_password(_DUMMY_HASH, body.password)
        raise HTTPException(status_code=401, detail="wrong username or password")
    if not verify_password(user.password_hash, body.password):
        raise HTTPException(status_code=401, detail="wrong username or password")

    return await _open_session(user, request, response, session)


@router.get("/register/challenge")
async def registration_challenge(request: Request) -> dict[str, Any]:
    """A proof-of-work challenge for the registration form.

    Also the feature probe: the login screen shows its registration link only when this
    answers 200. Challenges are stateless and HMAC-signed with a per-boot key, so
    issuing one costs nothing to keep.
    """
    if not get_settings().registration_enabled:
        raise HTTPException(status_code=403, detail="registration is disabled")
    return new_challenge(request.app.state.registration_hmac_key)


@router.post("/register", status_code=201)
async def register(
    body: RegisterRequest, request: Request, response: Response, session: SessionDep
) -> SessionResponse:
    settings = get_settings()
    if not settings.registration_enabled:
        raise HTTPException(status_code=403, detail="registration is disabled")

    by_ip: SlidingWindowLimiter = request.app.state.registration_limiter_by_ip
    overall: SlidingWindowLimiter = request.app.state.registration_limiter_global
    client_ip = request.client.host if request.client else "unknown"
    if not by_ip.allow(client_ip) or not overall.allow("registrations"):
        raise HTTPException(status_code=429, detail="too many registrations, try again later")

    # The captcha gates everything that touches the database, so probing usernames or
    # filling the pending list costs real work per attempt.
    if not payload_is_valid(body.altcha, request.app.state.registration_hmac_key):
        raise HTTPException(status_code=422, detail="the captcha check failed — reload and retry")
    if not request.app.state.registration_solved.consume(body.altcha):
        raise HTTPException(status_code=422, detail="that captcha response was already used")

    problem = username_error(body.username, settings.admin_username)
    if problem is not None:
        raise HTTPException(status_code=422, detail=problem)

    pending_count = await session.scalar(
        select(func.count())
        .select_from(User)
        .where(User.is_whitelisted.is_(False), User.is_admin.is_(False))
    )
    if int(pending_count or 0) >= settings.registration_pending_max:
        raise HTTPException(
            status_code=429,
            detail="registration is temporarily full — try again after accounts are approved",
        )

    existing = await session.execute(select(User).where(User.username == body.username))
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="that username is taken")

    user = User(username=body.username, password_hash=hash_password(body.password))
    session.add(user)
    await session.commit()
    return await _open_session(user, request, response, session)


@router.post("/refresh")
async def refresh(request: Request, response: Response, session: SessionDep) -> SessionResponse:
    token = request.cookies.get(REFRESH_COOKIE)
    if token is None:
        raise HTTPException(status_code=401, detail="no session")
    result = await session.execute(
        select(RefreshToken).where(RefreshToken.token_hash == hash_refresh_token(token))
    )
    row = result.scalar_one_or_none()
    if row is None or row.revoked_at is not None or row.expires_at <= now_iso():
        _clear_refresh_cookie(response, request)
        raise HTTPException(status_code=401, detail="session expired")
    user = await session.get(User, row.user_id)
    if user is None:
        _clear_refresh_cookie(response, request)
        raise HTTPException(status_code=401, detail="unknown account")
    if not user.is_whitelisted:
        # A revoked whitelist takes effect now: any editor socket this user still holds
        # is closed rather than allowed to ride out its token.
        await request.app.state.hub.kick_user(user.id)
    settings = get_settings()
    return _session_response(user, request.app.state.jwt_secret, settings.access_ttl)


@router.post("/logout")
async def logout(request: Request, session: SessionDep) -> Response:
    response = Response(status_code=204)
    token = request.cookies.get(REFRESH_COOKIE)
    if token is not None:
        result = await session.execute(
            select(RefreshToken).where(RefreshToken.token_hash == hash_refresh_token(token))
        )
        row = result.scalar_one_or_none()
        if row is not None and row.revoked_at is None:
            row.revoked_at = now_iso()
            await session.commit()
    _clear_refresh_cookie(response, request)
    return response


@router.get("/me")
async def me(user: CurrentUser) -> SessionUser:
    return _session_user(user)


@router.post("/password")
async def change_password(
    body: PasswordChangeRequest, user: CurrentUser, session: SessionDep
) -> Response:
    if user.is_admin:
        raise HTTPException(
            status_code=403,
            detail="the administrator password is set in /run/secrets/admin_password on the host",
        )
    if not verify_password(user.password_hash, body.current_password):
        raise HTTPException(status_code=403, detail="current password is wrong")
    user.password_hash = hash_password(body.new_password)
    await session.commit()
    return Response(status_code=204)
