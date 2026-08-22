"""Self-registration protection.

Three independent brakes, all always on: a proof-of-work captcha solved in the
applicant's browser (self-hosted, no third party involved), per-source rate limits, and
a hard cap on how many not-yet-approved accounts may exist at once. An account that gets
through all three still sees nothing until an administrator approves it.
"""

import hashlib
import re
import time
from datetime import UTC, datetime, timedelta
from typing import Any

from altcha import create_challenge, verify_solution

# PBKDF2 iterations per proof-of-work attempt. The browser needs a few hundred attempts
# on average, which lands under a second for a person and adds up for a bot farm.
CHALLENGE_COST = 5_000
CHALLENGE_ALGORITHM = "PBKDF2/SHA-256"
CHALLENGE_TTL_SECONDS = 300

USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$")


def username_error(username: str, admin_username: str) -> str | None:
    """Why a requested username is not acceptable, or None when it is."""
    if not USERNAME_PATTERN.match(username):
        return (
            "usernames are 3–32 characters: letters, digits, '.', '_' and '-', "
            "starting with a letter or digit"
        )
    if username.lower() == admin_username.lower():
        return "that username is reserved"
    return None


def new_challenge(hmac_key: str) -> dict[str, Any]:
    """A fresh, signed, short-lived proof-of-work challenge in the widget's wire format."""
    challenge = create_challenge(
        CHALLENGE_ALGORITHM,
        CHALLENGE_COST,
        hmac_secret=hmac_key,
        expires_at=datetime.now(UTC) + timedelta(seconds=CHALLENGE_TTL_SECONDS),
    )
    payload: dict[str, Any] = challenge.to_dict()
    return payload


class SolvedChallenges:
    """Single-use enforcement for solved challenges.

    Challenges already expire quickly; this closes the window in which one solved
    payload could be replayed for many accounts. Process memory is the right store for
    the same reason it is for the rate limiters: one instance, one event loop.
    """

    def __init__(self) -> None:
        self._seen: dict[str, float] = {}

    def consume(self, payload: str) -> bool:
        """Record the payload and report whether it was fresh."""
        token = hashlib.sha256(payload.encode("utf-8")).hexdigest()
        now = time.monotonic()
        if token in self._seen and self._seen[token] > now:
            return False
        self._seen[token] = now + CHALLENGE_TTL_SECONDS
        return True

    def sweep(self) -> None:
        now = time.monotonic()
        for token in [token for token, deadline in self._seen.items() if deadline <= now]:
            del self._seen[token]


def payload_is_valid(payload: str, hmac_key: str) -> bool:
    """Whether a submitted proof-of-work payload solves a challenge we recently issued."""
    try:
        result = verify_solution(payload, hmac_key)
    except Exception:  # a malformed payload is a failed check, whatever shape it takes
        return False
    return bool(result.verified) and not bool(result.expired)
