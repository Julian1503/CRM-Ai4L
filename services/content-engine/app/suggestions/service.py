"""One suggestion request: parse the context, prompt the model, clean the answer.

A person waits on the other end, so the whole call — the model's own retries included —
runs under one deadline. An answer that is empty once cleaned is asked for again once;
after that the request fails rather than showing nothing as if it had worked.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel

from app.generation.llm import LLMClient, LLMError
from app.suggestions import offline, prompts, sanitize
from app.suggestions.models import (
    BriefCompletionContext,
    ContentIdeasContext,
    ImagePromptsContext,
    RawBriefCompletion,
    RawIdeas,
    RawImagePrompts,
    RawInstructions,
    RewriteContext,
    SuggestionKind,
)

logger = logging.getLogger(__name__)

_ATTEMPTS_WHEN_EMPTY = 2


class SuggestionError(RuntimeError):
    """A failure with the HTTP status and the machine code the CRM branches on."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code


@dataclass(frozen=True, slots=True)
class _Spec:
    context: type[BaseModel]
    raw: type[BaseModel]
    render: Callable[[Any], str]
    offline: Callable[[Any], BaseModel]
    sanitize: Callable[[Any, Any], dict[str, Any]]


_SPECS: dict[SuggestionKind, _Spec] = {
    "rewrite_instructions": _Spec(
        RewriteContext,
        RawInstructions,
        prompts.render_rewrite,
        offline.offline_rewrite,
        sanitize.sanitize_rewrite,
    ),
    "image_prompts": _Spec(
        ImagePromptsContext,
        RawImagePrompts,
        prompts.render_image_prompts,
        offline.offline_image_prompts,
        sanitize.sanitize_image_prompts,
    ),
    "brief_completion": _Spec(
        BriefCompletionContext,
        RawBriefCompletion,
        prompts.render_brief_completion,
        offline.offline_brief_completion,
        sanitize.sanitize_brief_completion,
    ),
    "content_ideas": _Spec(
        ContentIdeasContext,
        RawIdeas,
        prompts.render_content_ideas,
        offline.offline_content_ideas,
        sanitize.sanitize_content_ideas,
    ),
}


def parse_context(kind: SuggestionKind, body: bytes) -> BaseModel:
    """The request's context; raises pydantic's ValidationError when it does not fit."""
    return _SPECS[kind].context.model_validate_json(body)


async def _ask(spec: _Spec, ctx: BaseModel, llm: LLMClient) -> tuple[dict[str, Any], dict[str, int]]:
    prompt = spec.render(ctx)
    usage: dict[str, int] = {}
    result: dict[str, Any] = {}
    for _ in range(_ATTEMPTS_WHEN_EMPTY):
        response = await llm.complete_structured(prompt, spec.raw, offline=lambda: spec.offline(ctx))
        for name, value in response.usage.items():
            usage[name] = usage.get(name, 0) + value
        result = spec.sanitize(response.parsed, ctx)
        if not sanitize.is_empty(result):
            return result, usage
    raise SuggestionError(502, "suggestions_empty", "The model returned no usable suggestion.")


async def _ask_in_slot(
    spec: _Spec, ctx: BaseModel, llm: LLMClient, slots: asyncio.Semaphore | None
) -> tuple[dict[str, Any], dict[str, int]]:
    if slots is None:
        return await _ask(spec, ctx, llm)
    async with slots:
        return await _ask(spec, ctx, llm)


async def suggest(
    kind: SuggestionKind,
    ctx: BaseModel,
    llm: LLMClient,
    *,
    deadline_seconds: float,
    slots: asyncio.Semaphore | None = None,
) -> dict[str, Any]:
    """``{..result, model, promptVersion, usage}`` for one parsed context.

    ``slots`` bounds concurrent model calls; the deadline includes waiting for one.
    """
    started = time.monotonic()
    try:
        result, usage = await asyncio.wait_for(
            _ask_in_slot(_SPECS[kind], ctx, llm, slots), timeout=deadline_seconds
        )
    except TimeoutError:
        raise SuggestionError(504, "suggestions_timeout", "The model took too long to answer.") from None
    except LLMError as exc:
        status, code = (
            (502, "suggestions_invalid") if exc.kind == "invalid" else (503, "suggestions_unavailable")
        )
        raise SuggestionError(status, code, "The model could not answer right now.") from None
    finally:
        logger.info("suggest kind=%s elapsed_ms=%d", kind, round((time.monotonic() - started) * 1000))
    return {
        **result,
        "model": llm.model_name,
        "promptVersion": prompts.SUGGEST_PROMPT_VERSION,
        "usage": usage,
    }
