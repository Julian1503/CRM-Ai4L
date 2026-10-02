"""publish_social: prepare → checkpoint → begin-dispatch → dispatch (once) → complete | fail.

Outcome mapping:

* prepare ``transient``/``rate_limited`` or a network error → ``retry`` (nothing public
  happened; begin-dispatch has not been called);
* prepare ``reauth``/``invalid``/``unreachable_media`` → ``failed``;
* dispatch ``DispatchRejected`` (structured 4xx) → ``failed``;
* dispatch ``DispatchUncertain`` (5xx, timeout, non-JSON, no id) or ANY unexpected error
  after begin-dispatch → ``uncertain``. The dispatch call is never retried.

The access token lives only in the context object for this lease. It is never put in a
checkpoint, a result, an error message or a log line.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from app.contracts import PublishSocialContext, PublishSocialResult
from app.jobs.deps import Deps
from app.jobs.session import JobFailure, JobSession
from app.redact import redact
from app.social.publishers.base import (
    PREPARED_KEY,
    DispatchRejected,
    DispatchUncertain,
    OutgoingImage,
    PublishError,
    PublishRequest,
    ResolvedAccount,
)
from app.social.rules import dispatch_blockers

logger = logging.getLogger(__name__)


def build_request(context: PublishSocialContext) -> PublishRequest:
    account = context.account
    return PublishRequest(
        platform=context.platform,
        text=context.text,
        account=ResolvedAccount(
            id=account.id,
            provider=account.provider,
            external_id=account.external_id,
            author_kind=account.author_kind,
            display_name=account.display_name,
            access_token=account.access_token,
        ),
        images=tuple(
            OutgoingImage(url=i.url, alt=i.alt, mime_type=i.mime_type, width=i.width, height=i.height)
            for i in context.images
        ),
        link=context.link_url,
    )


def _scrub(message: str, token: str) -> str:
    cleaned = redact(message)
    return cleaned.replace(token, "REDACTED") if token else cleaned


async def handle(session: JobSession, context: PublishSocialContext, deps: Deps) -> dict[str, Any]:
    token = context.account.access_token
    blockers = dispatch_blockers(context.platform, context.text, list(context.images))
    if blockers:
        raise JobFailure("failed", "preflight_failed", " ".join(blockers))
    request = build_request(context)
    publisher = deps.publisher_for(context.platform, context.account.provider)
    saved = {**session.job.checkpoint, **context.checkpoint}

    try:
        prepared = await publisher.prepare(request, saved)
    except PublishError as exc:
        outcome = "retry" if exc.code in ("transient", "rate_limited") else "failed"
        raise JobFailure(outcome, f"prepare_{exc.code}", _scrub(str(exc), token)) from None  # type: ignore[arg-type]
    except httpx.HTTPError as exc:
        raise JobFailure(
            "retry", "prepare_network", f"Network error while preparing ({type(exc).__name__})."
        ) from None

    await session.checkpoint({PREPARED_KEY: prepared})
    await session.begin_dispatch()

    try:
        result = await publisher.dispatch(request, prepared)
    except DispatchRejected as exc:
        raise JobFailure("failed", f"dispatch_{exc.code}", _scrub(str(exc), token)) from None
    except DispatchUncertain as exc:
        raise JobFailure(
            "uncertain", exc.code, _scrub(str(exc), token), provider_request_id=exc.provider_request_id
        ) from None
    except Exception as exc:  # noqa: BLE001 - after begin-dispatch anything unexplained is uncertain
        logger.error("Job %s: unexpected dispatch failure (%s)", session.job_id, type(exc).__name__)
        raise JobFailure(
            "uncertain", "dispatch_unexpected", f"Unexpected failure while publishing ({type(exc).__name__})."
        ) from None

    permalink = result.permalink if result.permalink and result.permalink.startswith("https://") else None
    return PublishSocialResult(
        external_id=result.external_id, permalink=permalink, provider_request_id=result.provider_request_id
    ).to_wire()
