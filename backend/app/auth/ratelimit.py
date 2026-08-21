"""In-memory sliding-window rate limiting.

The service runs as a single instance with one event loop, so a process-local structure
is the whole implementation: no locks, no external store, cleared by a restart.
"""

import time
from collections import deque


class SlidingWindowLimiter:
    def __init__(self, limit: int, window_seconds: float) -> None:
        self._limit = limit
        self._window = window_seconds
        self._events: dict[str, deque[float]] = {}

    def allow(self, key: str) -> bool:
        """Record an attempt for the key and report whether it was within the limit."""
        now = time.monotonic()
        events = self._events.setdefault(key, deque())
        while events and now - events[0] > self._window:
            events.popleft()
        if len(events) >= self._limit:
            return False
        events.append(now)
        return True

    def sweep(self) -> None:
        """Drop keys whose newest attempt has aged out, so idle keys do not accumulate."""
        now = time.monotonic()
        stale = [
            key
            for key, events in self._events.items()
            if not events or now - events[-1] > self._window
        ]
        for key in stale:
            del self._events[key]
