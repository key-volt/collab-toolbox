"""Access and refresh tokens.

The access token is a short-lived signed claim of identity and nothing more — every
authorization decision is read from the database at request time, so revoking someone
does not have to wait for a token to expire.

Refresh tokens are opaque random strings. Only their sha256 is stored, so a copy of the
database cannot be replayed as a session.
"""

import hashlib
import secrets
import time

import jwt


class TokenError(Exception):
    pass


def issue_access_token(user_id: str, secret: str, ttl_seconds: int) -> str:
    now = int(time.time())
    claims = {"sub": user_id, "iat": now, "exp": now + ttl_seconds, "type": "access"}
    return jwt.encode(claims, secret, algorithm="HS256")


def read_access_token(token: str, secret: str) -> str:
    """Return the user id the token names, or raise TokenError."""
    try:
        claims = jwt.decode(
            token,
            secret,
            algorithms=["HS256"],
            options={"require": ["sub", "exp"]},
        )
    except jwt.InvalidTokenError as exc:
        raise TokenError(str(exc)) from exc
    if claims.get("type") != "access":
        raise TokenError("not an access token")
    subject = claims["sub"]
    if not isinstance(subject, str):
        raise TokenError("malformed subject")
    return subject


def new_refresh_token() -> str:
    return secrets.token_urlsafe(48)


def hash_refresh_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
