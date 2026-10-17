"""Cleans a model's suggestions before they reach the CRM.

An entry that is empty, too long, carries a URL or repeats an earlier one is dropped
rather than clipped: a cut-off instruction or prompt reads worse than one fewer chip.
Fact ids are kept only when they name one of the brand's approved facts, and channels
only when they are among the channels offered — so a completed brief can never carry an
invented fact or a channel the CRM did not offer.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Any

from app.suggestions.models import (
    BriefCompletionContext,
    ContentIdeasContext,
    ImagePromptsContext,
    RawBriefCompletion,
    RawIdeas,
    RawImagePrompts,
    RawInstructions,
    RewriteContext,
)
from app.suggestions.prompts import IDEA_COUNT, IMAGE_PROMPT_COUNT, REWRITE_COUNT

_URL_RE = re.compile(r"https?://|www\.|mailto:|javascript:|data:", re.IGNORECASE)
_QUOTES = "\"'“”‘’`"

MAX_INSTRUCTION = 160
MAX_LABEL = 60
MAX_IMAGE_PROMPT = 800
MAX_TITLE = 200
MAX_TOPIC = 1000
MAX_ANGLE = 300
MAX_SHORT_FIELD = 200
MAX_NOTES = 1000
MAX_IDEA_CHANNELS = 3


def clean(text: str, limit: int) -> str | None:
    """Collapsed, unquoted text within ``limit``; None when it should be dropped."""
    value = " ".join(text.split()).strip(_QUOTES).strip()
    if not value or len(value) > limit or _URL_RE.search(value):
        return None
    return value


def _key(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


class _Seen:
    """Case- and punctuation-insensitive duplicate check, seeded with earlier suggestions."""

    def __init__(self, earlier: Iterable[str]) -> None:
        self._keys = {_key(item) for item in earlier}

    def first_time(self, text: str) -> bool:
        key = _key(text)
        if key in self._keys:
            return False
        self._keys.add(key)
        return True


def _channels(raw: Iterable[str], allowed: Iterable[str], limit: int) -> list[str]:
    offered = list(allowed)
    picked: list[str] = []
    for channel in raw:
        name = channel.strip().lower()
        if name in offered and name not in picked:
            picked.append(name)
    return picked[:limit]


def sanitize_rewrite(raw: RawInstructions, ctx: RewriteContext) -> dict[str, Any]:
    seen = _Seen(ctx.avoid)
    out: list[dict[str, str]] = []
    for entry in raw.suggestions:
        text = clean(entry.text, MAX_INSTRUCTION)
        if text and seen.first_time(text):
            out.append({"text": text})
    return {"suggestions": out[:REWRITE_COUNT]}


def sanitize_image_prompts(raw: RawImagePrompts, ctx: ImagePromptsContext) -> dict[str, Any]:
    seen = _Seen([*ctx.avoid, *ctx.used_prompts])
    out: list[dict[str, str]] = []
    for entry in raw.suggestions:
        prompt = clean(entry.prompt, MAX_IMAGE_PROMPT)
        if not prompt or not seen.first_time(prompt):
            continue
        label = clean(entry.label, MAX_LABEL) or prompt.split(".")[0][:MAX_LABEL].strip()
        out.append({"label": label, "prompt": prompt})
    return {"suggestions": out[:IMAGE_PROMPT_COUNT]}


def sanitize_brief_completion(raw: RawBriefCompletion, ctx: BriefCompletionContext) -> dict[str, Any]:
    fact_ids = {fact.id for fact in ctx.brand.approved_facts}
    picked_facts: list[str] = []
    for fact_id in raw.fact_ids:
        if fact_id in fact_ids and fact_id not in picked_facts:
            picked_facts.append(fact_id)

    completion: dict[str, Any] = {
        "factIds": picked_facts,
        "channels": _channels(raw.channels, ctx.channels, len(ctx.channels)),
    }
    for name, value, limit in (
        ("title", raw.title, MAX_TITLE),
        ("audience", raw.audience, MAX_SHORT_FIELD),
        ("objective", raw.objective, MAX_SHORT_FIELD),
        ("notes", raw.notes, MAX_NOTES),
    ):
        text = clean(value, limit)
        if text:
            completion[name] = text
    return {"completion": completion}


def sanitize_content_ideas(raw: RawIdeas, ctx: ContentIdeasContext) -> dict[str, Any]:
    seen = _Seen([*ctx.avoid, *ctx.recent_titles])
    out: list[dict[str, Any]] = []
    for entry in raw.suggestions:
        title = clean(entry.title, MAX_TITLE)
        topic = clean(entry.topic, MAX_TOPIC)
        if not title or not topic or not seen.first_time(title):
            continue
        out.append(
            {
                "title": title,
                "topic": topic,
                "angle": clean(entry.angle, MAX_ANGLE) or "",
                "channels": _channels(entry.channels, ctx.channels, MAX_IDEA_CHANNELS)
                or list(ctx.channels[:1]),
            }
        )
    return {"suggestions": out[:IDEA_COUNT]}


def is_empty(result: dict[str, Any]) -> bool:
    """A result worth nothing to the person: no suggestion, or a completion with no text."""
    if "completion" in result:
        return not any(key in result["completion"] for key in ("title", "audience", "objective", "notes"))
    return not result.get("suggestions")
