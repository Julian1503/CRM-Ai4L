"""generate_text: reference fetch → prompts → begin-dispatch → provider calls → complete.

Fail rule when no channel produced a draft (partial results always complete):

* every failure ``transient`` (timeout, connection, 429, 5xx, deadline) → ``retry``;
  SQL requeues with backoff until ``max_attempts``, then closes as ``failed``;
* any ``invalid`` (malformed output after the in-call retries) or ``config`` (auth, bad
  model, bad request) → ``failed``: repeating the same request will not fix it.

``uncertain`` is never used for generation: it has no public effect. The only cost of a
retry after a timeout is a possibly-billed provider call, bounded by ``max_attempts``.
"""

from __future__ import annotations

import logging
from typing import Any

from app.contracts import GenerateTextContext, GenerateTextResult
from app.generation.orchestrate import plan_drafts, run_drafts
from app.generation.prompts import PROMPT_VERSION
from app.generation.reference import fetch_reference_excerpt
from app.jobs.deps import Deps
from app.jobs.session import JobFailure, JobSession

logger = logging.getLogger(__name__)


def failure_outcome(kinds: list[str]) -> str:
    return "retry" if kinds and all(kind == "transient" for kind in kinds) else "failed"


async def handle(session: JobSession, context: GenerateTextContext, deps: Deps) -> dict[str, Any]:
    brief = context.input.brief
    excerpt: str | None = None
    if brief.reference_url:
        excerpt, warning = await fetch_reference_excerpt(
            brief.reference_url,
            deps.fetch_limits,
            resolver=deps.reference_resolver,
            transport=deps.reference_transport,
        )
        if warning:
            logger.info("Job %s: %s", session.job_id, warning)
    session.ensure_can_continue()

    plans = plan_drafts(context, excerpt)
    if not plans:
        raise JobFailure("failed", "no_channels", "The job requested no channels.")

    await session.begin_dispatch()
    settings = deps.settings
    outcome = await run_drafts(
        plans,
        deps.llm,
        concurrency=settings.llm_max_concurrency,
        deadline_seconds=settings.generation_deadline_seconds,
    )
    request_id = outcome.request_ids[0] if outcome.request_ids else None
    if not outcome.variants:
        first = outcome.failures[0] if outcome.failures else None
        raise JobFailure(
            failure_outcome(outcome.failure_kinds),  # type: ignore[arg-type]
            first.error_code if first else "llm_failed",
            "; ".join(f"{f.channel}: {f.message}" for f in outcome.failures)[:1000]
            or "No draft was produced.",
            provider_request_id=request_id,
        )
    result = GenerateTextResult(
        variants=outcome.variants,
        failures=outcome.failures,
        prompt_version=PROMPT_VERSION,
        model=deps.llm.model_name,
        provider_request_id=request_id,
        usage=outcome.usage or None,
    )
    return result.to_wire()
