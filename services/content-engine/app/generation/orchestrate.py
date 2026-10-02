"""Fan-out of one generate_text job: channels × styles, with partial results.

WRCC's ``run_all`` cancelled every sibling on the first failure. Here every
(channel, style) call is independent: one channel failing never cancels another, and a
channel that produced nothing is reported in ``failures`` so the CRM can repeat only
that one. Calls share one semaphore (LLM_MAX_CONCURRENCY) and one job deadline.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field

from pydantic import BaseModel

from app.contracts import (
    ContentChannel,
    GeneratedVariant,
    GenerateTextContext,
    GenerationFailure,
)
from app.generation.llm import EmailDraft, LLMClient, LLMError, LLMResponse, SocialPostDraft, classify_error
from app.generation.profiles import VARIANT_STYLES, profile_for, url_allowed, validate_email, validate_social
from app.generation.prompts import (
    PROMPT_VERSION,
    DraftContext,
    collect_facts,
    render_email_prompt,
    render_social_prompt,
)
from app.redact import redact

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class PlannedDraft:
    ctx: DraftContext
    prompt: str
    schema: type[BaseModel]


@dataclass(slots=True)
class GenerationOutcome:
    variants: list[GeneratedVariant] = field(default_factory=list)
    failures: list[GenerationFailure] = field(default_factory=list)
    failure_kinds: list[str] = field(default_factory=list)
    request_ids: list[str] = field(default_factory=list)
    usage: dict[str, int] = field(default_factory=dict)


def plan_drafts(context: GenerateTextContext, reference_excerpt: str | None) -> list[PlannedDraft]:
    """Build every prompt up front — before begin-dispatch, so nothing costs money yet."""
    job = context.input
    brand = context.brand
    facts = collect_facts(brand, job.brief)
    link = (
        job.brief.reference_url
        if job.brief.reference_url and url_allowed(job.brief.reference_url, brand.allowed_link_origins)
        else None
    )
    count = max(1, min(job.styles_per_channel, len(VARIANT_STYLES)))
    planned: list[PlannedDraft] = []
    for channel in dict.fromkeys(job.channels):
        profile = profile_for(channel, brand, context.platform_limits.get(channel))
        for style in VARIANT_STYLES[:count]:
            ctx = DraftContext(
                channel=channel,
                style=style,
                brand=brand,
                brief=job.brief,
                profile=profile,
                facts=facts,
                reference_excerpt=reference_excerpt,
                instruction=job.instruction,
                base_revision=context.base_revision,
                link_url=link,
                hashtag_seeds=tuple(brand.hashtag_seeds),
            )
            is_email = channel == "email"
            prompt = render_email_prompt(ctx) if is_email else render_social_prompt(ctx)
            planned.append(
                PlannedDraft(ctx=ctx, prompt=prompt, schema=EmailDraft if is_email else SocialPostDraft)
            )
    return planned


def to_variant(plan: PlannedDraft, response: LLMResponse) -> GeneratedVariant:
    ctx = plan.ctx
    allowed = ctx.brand.allowed_link_origins
    if isinstance(response.parsed, EmailDraft):
        fields = response.parsed.as_fields()
        return GeneratedVariant(
            channel=ctx.channel,
            style=ctx.style,
            body=fields["body"],
            hashtags=[],
            call_to_action=fields["ctaLabel"],
            link_url=ctx.link_url,
            fields=fields,
            violations=validate_email(fields, allowed_origins=allowed),
            prompt_version=PROMPT_VERSION,
        )
    assert isinstance(response.parsed, SocialPostDraft)
    post = response.parsed
    hashtags = [tag.strip() for tag in post.hashtags if tag.strip()]
    return GeneratedVariant(
        channel=ctx.channel,
        style=ctx.style,
        body=post.body,
        hashtags=hashtags,
        call_to_action=post.call_to_action,
        link_url=ctx.link_url,
        violations=validate_social(
            ctx.profile,
            body=post.body,
            hashtags=hashtags,
            call_to_action=post.call_to_action,
            allowed_origins=allowed,
        ),
        prompt_version=PROMPT_VERSION,
    )


def _rank_key(variant: GeneratedVariant) -> tuple[int, int]:
    return (len(variant.violations), -len(variant.body))


async def run_drafts(
    plans: list[PlannedDraft], llm: LLMClient, *, concurrency: int, deadline_seconds: float
) -> GenerationOutcome:
    semaphore = asyncio.Semaphore(concurrency)

    async def one(plan: PlannedDraft) -> LLMResponse:
        async with semaphore:
            return await llm.complete_json(plan.prompt, plan.schema, plan.ctx)

    tasks = [asyncio.create_task(one(plan)) for plan in plans]
    if tasks:
        _done, pending = await asyncio.wait(tasks, timeout=deadline_seconds)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
    return _collect(plans, tasks)


def _collect(plans: list[PlannedDraft], tasks: list[asyncio.Task[LLMResponse]]) -> GenerationOutcome:
    outcome = GenerationOutcome()
    by_channel: dict[ContentChannel, list[GeneratedVariant]] = {}
    errors: dict[ContentChannel, BaseException] = {}
    for plan, task in zip(plans, tasks, strict=True):
        channel = plan.ctx.channel
        by_channel.setdefault(channel, [])
        if task.cancelled():
            errors.setdefault(channel, LLMError("transient", "Generation deadline reached."))
            continue
        exc = task.exception()
        if exc is not None:
            logger.warning("Draft %s/%s failed: %s", channel, plan.ctx.style, redact(exc))
            errors.setdefault(channel, exc)
            continue
        response = task.result()
        if response.request_id:
            outcome.request_ids.append(response.request_id)
        for key, value in response.usage.items():
            outcome.usage[key] = outcome.usage.get(key, 0) + value
        by_channel[channel].append(to_variant(plan, response))

    for channel, variants in by_channel.items():
        if variants:
            outcome.variants.extend(sorted(variants, key=_rank_key))
            continue
        exc = errors.get(channel) or LLMError("transient", "No draft was produced.")
        kind = classify_error(exc)
        outcome.failure_kinds.append(kind)
        outcome.failures.append(
            GenerationFailure(channel=channel, error_code=f"llm_{kind}", message=redact(exc)[:500])  # type: ignore[arg-type]
        )
    return outcome
