"""Text LLM clients: mock (default), OpenAI and Gemini.

Ported from WRCC ``llm/client.py``. Differences:

* clients return structured output for any pydantic schema (social post or email
  fields) plus the provider request id and token usage, so the job can record them;
* errors are classified — ``transient`` (timeout, connection, 429, 5xx), ``invalid``
  (the model answered but not in the required shape) and ``config`` (auth, bad request,
  unknown model) — because the worker's fail outcome depends on it;
* the mock is brand-driven: no college, region or course copy is baked in.

SDK retries are switched off; ``with_retries`` is the only retry layer and never
retries a ``config`` error.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, TypeVar

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.config import Settings
from app.generation.prompts import DraftContext
from app.redact import redact

logger = logging.getLogger(__name__)

ErrorKind = Literal["transient", "invalid", "config"]
_BACKOFF_SECONDS = 0.5
_REASONING_MODEL_PREFIXES = ("gpt-5", "o1", "o3", "o4")


class SocialPostDraft(BaseModel):
    body: str = Field(min_length=1)
    hashtags: list[str] = Field(default_factory=list)
    call_to_action: str | None = None


class EmailDraft(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    subject: str = Field(min_length=1, max_length=90)
    preheader: str = Field(min_length=1, max_length=120)
    headline: str = Field(min_length=1, max_length=80)
    intro: str = Field(min_length=1, max_length=320)
    body: str = Field(min_length=1, max_length=1200)
    cta_label: str = Field(min_length=1, max_length=28, alias="ctaLabel")

    def as_fields(self) -> dict[str, str]:
        return self.model_dump(by_alias=True)


class LLMError(RuntimeError):
    def __init__(self, kind: ErrorKind, message: str, *, request_id: str | None = None) -> None:
        super().__init__(message)
        self.kind: ErrorKind = kind
        self.request_id = request_id


@dataclass(frozen=True, slots=True)
class LLMResponse:
    parsed: BaseModel
    request_id: str | None = None
    usage: dict[str, int] = field(default_factory=dict)


S = TypeVar("S", bound=BaseModel)
T = TypeVar("T")


class LLMClient(Protocol):
    model_name: str

    async def complete_json(self, prompt: str, schema: type[BaseModel], ctx: DraftContext) -> LLMResponse: ...


def supports_reasoning_effort(model: str) -> bool:
    return model.startswith(_REASONING_MODEL_PREFIXES)


def classify_error(exc: BaseException) -> ErrorKind:
    if isinstance(exc, LLMError):
        return exc.kind
    if isinstance(exc, (ValidationError, ValueError)):
        return "invalid"
    if isinstance(exc, (TimeoutError, ConnectionError)):
        return "transient"
    status = getattr(exc, "status_code", None) or getattr(exc, "code", None)
    name = type(exc).__name__
    if name in {
        "APITimeoutError",
        "APIConnectionError",
        "RateLimitError",
        "InternalServerError",
        "ServerError",
    }:
        return "transient"
    if isinstance(status, int):
        return "transient" if status == 429 or status >= 500 else "config"
    if name.endswith(("TimeoutException", "NetworkError", "ConnectError", "ReadError")):
        return "transient"
    return "transient"


async def with_retries(label: str, attempt_once: Callable[[], Awaitable[T]], *, attempts: int) -> T:
    """Retry transient and invalid-output failures; a config error stops at once."""
    last: BaseException | None = None
    for attempt in range(1, attempts + 1):
        try:
            return await attempt_once()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - classified below
            last = exc
            kind = classify_error(exc)
            logger.warning("%s attempt %d/%d failed (%s): %s", label, attempt, attempts, kind, redact(exc))
            if kind == "config" or attempt == attempts:
                break
            await asyncio.sleep(_BACKOFF_SECONDS * attempt)
    assert last is not None
    kind = classify_error(last)
    raise LLMError(kind, f"{label} failed ({kind}): {redact(last)[:300]}") from last


# --- Mock ---------------------------------------------------------------------------------

_WORD_RE = re.compile(r"[A-Za-z0-9]{3,}")
_OPENERS = {
    "direct": "{topic}: here is what you need to know.",
    "story_led": "It started with a simple question about {topic}, and the answer changed how we work.",
    "question_led": "What would change for you with {topic}?",
}


def hashtagify(text: str) -> str:
    return "#" + "".join(word.capitalize() for word in _WORD_RE.findall(text))[:28]


def _mock_hashtags(ctx: DraftContext, count: int) -> list[str]:
    tags: list[str] = []
    for seed in [
        *ctx.hashtag_seeds,
        ctx.brand.name,
        ctx.brief.topic,
        "Insights",
        "Learning",
        "Community",
        "Growth",
        "Innovation",
        "Teams",
        "Skills",
        "Future",
        "Ideas",
        "Update",
        "News",
        "Tips",
    ]:
        tag = hashtagify(seed)
        if len(tag) > 1 and tag not in tags:
            tags.append(tag)
        if len(tags) >= count:
            break
    return tags


def _mock_social(ctx: DraftContext) -> SocialPostDraft:
    profile = ctx.profile
    parts = [_OPENERS.get(ctx.style, _OPENERS["direct"]).format(topic=ctx.brief.topic)]
    if ctx.instruction:
        parts.append(f"({ctx.instruction})")
    if ctx.brief.notes:
        parts.append(ctx.brief.notes)
    parts.extend(ctx.facts[:2])
    body = " ".join(part for part in parts if part).strip()
    padding = f" {ctx.brand.name} shares practical ideas for {ctx.brief.audience or ctx.brand.audience}."
    while len(body) < profile.min_length:
        body += padding
    if len(body) > profile.max_length:
        body = body[: profile.max_length - 1].rstrip() + "…"
    return SocialPostDraft(
        body=body,
        hashtags=_mock_hashtags(ctx, max(profile.hashtags_min, 0)),
        call_to_action=profile.cta or "Find out more.",
    )


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _mock_email(ctx: DraftContext) -> EmailDraft:
    topic = ctx.brief.topic
    facts = " ".join(ctx.facts[:3])
    body = f"{_OPENERS.get(ctx.style, _OPENERS['direct']).format(topic=topic)} {facts}".strip()
    if ctx.instruction:
        body = f"{body} ({ctx.instruction})"
    return EmailDraft(
        subject=_clip(f"{topic} | {ctx.brand.name}", 90),
        preheader=_clip(f"What {topic} means for {ctx.brief.audience or ctx.brand.audience}.", 120),
        headline=_clip(topic, 80),
        intro=_clip(f"A short update from {ctx.brand.name} on {topic}.", 320),
        body=_clip(body, 1200),
        ctaLabel=_clip(ctx.profile.cta or "Learn more", 28),
    )


class MockLLMClient:
    """Deterministic offline client: output depends only on the draft context."""

    model_name = "mock"

    async def complete_json(self, prompt: str, schema: type[BaseModel], ctx: DraftContext) -> LLMResponse:
        digest = hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:16]
        parsed: BaseModel = _mock_email(ctx) if schema is EmailDraft else _mock_social(ctx)
        return LLMResponse(parsed=parsed, request_id=f"mock-{digest}", usage={})


# --- Live ----------------------------------------------------------------------------------


class OpenAILLMClient:
    def __init__(self, settings: Settings) -> None:
        from openai import AsyncOpenAI

        self._client = AsyncOpenAI(
            api_key=settings.openai_api_key, timeout=settings.llm_timeout_seconds, max_retries=0
        )
        self.model_name = settings.openai_model
        self._attempts = settings.llm_max_attempts
        effort = settings.openai_reasoning_effort
        self._options: dict[str, Any] = (
            {"reasoning_effort": effort} if effort and supports_reasoning_effort(self.model_name) else {}
        )

    async def complete_json(self, prompt: str, schema: type[BaseModel], ctx: DraftContext) -> LLMResponse:
        async def attempt_once() -> LLMResponse:
            response = await self._client.chat.completions.create(
                model=self.model_name,
                messages=[{"role": "user", "content": prompt}],
                response_format={"type": "json_object"},
                **self._options,
            )
            content = response.choices[0].message.content or ""
            usage = response.usage
            return LLMResponse(
                parsed=schema.model_validate_json(content),
                request_id=getattr(response, "id", None),
                usage={
                    "promptTokens": int(getattr(usage, "prompt_tokens", 0) or 0),
                    "completionTokens": int(getattr(usage, "completion_tokens", 0) or 0),
                }
                if usage
                else {},
            )

        return await with_retries("OpenAI", attempt_once, attempts=self._attempts)


class GeminiLLMClient:
    def __init__(self, settings: Settings) -> None:
        from google import genai
        from google.genai import types

        self._client = genai.Client(
            api_key=settings.gemini_api_key,
            http_options=types.HttpOptions(timeout=round(settings.llm_timeout_seconds * 1000)),
        )
        self.model_name = settings.gemini_model
        self._attempts = settings.llm_max_attempts

    async def complete_json(self, prompt: str, schema: type[BaseModel], ctx: DraftContext) -> LLMResponse:
        async def attempt_once() -> LLMResponse:
            response = await self._client.aio.models.generate_content(
                model=self.model_name,
                contents=prompt,
                config={"response_mime_type": "application/json", "response_schema": schema},
            )
            meta = getattr(response, "usage_metadata", None)
            return LLMResponse(
                parsed=schema.model_validate_json(response.text or ""),
                request_id=getattr(response, "response_id", None),
                usage={
                    "promptTokens": int(getattr(meta, "prompt_token_count", 0) or 0),
                    "completionTokens": int(getattr(meta, "candidates_token_count", 0) or 0),
                }
                if meta
                else {},
            )

        return await with_retries("Gemini", attempt_once, attempts=self._attempts)


def get_llm_client(settings: Settings) -> LLMClient:
    if settings.llm_mock:
        return MockLLMClient()
    if settings.llm_provider == "openai":
        return OpenAILLMClient(settings)
    return GeminiLLMClient(settings)
