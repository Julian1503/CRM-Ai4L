"""Shared publisher plumbing: configuration and error translation."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TypeVar

import httpx

from app.config import Settings
from app.redact import redact
from app.social.meta_graph import MetaAuthError, MetaGraphError, MetaRateLimitError, MetaTransientError
from app.social.publishers.base import DispatchRejected, DispatchUncertain, PublishError

T = TypeVar("T")


@dataclass(frozen=True, slots=True)
class PublisherConfig:
    graph_base_url: str
    timeout: float
    max_attempts: int
    retry_base_delay: float
    instagram_poll_attempts: int
    instagram_poll_delay: float
    linkedin_api_version: str
    max_image_bytes: int

    @classmethod
    def from_settings(cls, settings: Settings) -> PublisherConfig:
        return cls(
            graph_base_url=settings.graph_base_url,
            timeout=settings.publish_timeout_seconds,
            max_attempts=settings.publish_max_attempts,
            retry_base_delay=settings.publish_retry_base_delay_seconds,
            instagram_poll_attempts=settings.instagram_container_poll_attempts,
            instagram_poll_delay=settings.instagram_container_poll_delay_seconds,
            linkedin_api_version=settings.linkedin_api_version,
            max_image_bytes=settings.media_max_source_bytes,
        )


def graph_prepare_error(exc: MetaGraphError) -> PublishError:
    """Prepare phase: translate Graph failures into retryable/definitive codes."""
    if isinstance(exc, MetaAuthError):
        return PublishError(f"{exc} Reconnect the account in Settings.", code="reauth")
    if isinstance(exc, MetaRateLimitError):
        return PublishError(f"{exc} Try again shortly.", code="rate_limited")
    if isinstance(exc, MetaTransientError) or not exc.structured:
        return PublishError(str(exc), code="transient")
    return PublishError(str(exc), code="invalid")


def graph_dispatch_error(exc: MetaGraphError) -> DispatchRejected | DispatchUncertain:
    """Dispatch phase: only a structured, non-transient Graph rejection proves nothing posted."""
    if isinstance(exc, MetaTransientError) or not exc.structured:
        return DispatchUncertain(
            f"Meta answered ambiguously ({exc}). The post may be live: check the account before retrying.",
            code="provider_ambiguous",
        )
    if isinstance(exc, MetaAuthError):
        return DispatchRejected(f"{exc} Reconnect the account in Settings.", code="reauth")
    if isinstance(exc, MetaRateLimitError):
        return DispatchRejected(f"{exc} Try again later.", code="rate_limited")
    return DispatchRejected(str(exc), code="invalid")


async def guard_dispatch_transport(call: Callable[[], Awaitable[T]]) -> T:
    """Transport failures on the public call: only a failed *connect* proves nothing was sent."""
    try:
        return await call()
    except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
        raise DispatchRejected(
            f"Could not reach the network ({type(exc).__name__}).", code="unreachable"
        ) from None
    except httpx.HTTPError as exc:
        raise DispatchUncertain(
            f"The publish request did not complete ({type(exc).__name__}). The post may be live.",
            code="provider_timeout" if isinstance(exc, httpx.TimeoutException) else "provider_transport",
        ) from None


def describe(exc: BaseException) -> str:
    return redact(exc)
