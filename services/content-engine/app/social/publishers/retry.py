"""Bounded retry for the *prepare* phase only. Ported from WRCC ``publishers/retry.py``.

Only ``rate_limited`` and ``transient`` prepare failures are retried: scaffolding is
private and repeatable. ``dispatch`` is never passed to this helper — see
``publishers/base.py``. Network-level errors (timeouts, resets) are not
``PublishError`` and propagate to the worker, which reports them as ``retry`` because no
public effect can have happened before begin-dispatch.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import TypeVar

from app.redact import redact
from app.social.publishers.base import PublishError

logger = logging.getLogger(__name__)

RETRYABLE_CODES = frozenset({"rate_limited", "transient"})

T = TypeVar("T")


async def with_retries(
    operation: Callable[[], Awaitable[T]], *, attempts: int, base_delay: float, description: str
) -> T:
    for attempt in range(attempts):
        try:
            return await operation()
        except PublishError as exc:
            if exc.code not in RETRYABLE_CODES or attempt + 1 >= attempts:
                raise
            delay = base_delay * (2**attempt)
            logger.warning(
                "Retrying %s after %s failure (attempt %d/%d): %s",
                description,
                exc.code,
                attempt + 1,
                attempts,
                redact(exc),
            )
            if delay:
                await asyncio.sleep(delay)
    raise AssertionError("unreachable")  # pragma: no cover
