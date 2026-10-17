"""Suggestion contracts: what the CRM sends per kind, and what the model is asked for.

Request models are wire models (camelCase), bounded so a malformed or oversized body is
refused before a prompt is built. Raw models are deliberately loose — the model's answer
is cleaned by ``sanitize`` instead of failing validation on one long or empty entry.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field

from app.contracts import BrandProfile, ContentBrief, ContentChannel, WireModel

SuggestionKind = Literal["rewrite_instructions", "image_prompts", "brief_completion", "content_ideas"]
SUGGESTION_KINDS: tuple[SuggestionKind, ...] = (
    "rewrite_instructions",
    "image_prompts",
    "brief_completion",
    "content_ideas",
)

ShortText = Annotated[str, Field(max_length=600)]
LongText = Annotated[str, Field(max_length=4000)]


class _SuggestionRequest(WireModel):
    brand: BrandProfile
    # Suggestions already shown for the same context: the model is asked for new ones.
    avoid: list[ShortText] = Field(default_factory=list, max_length=20)


class RewriteContext(_SuggestionRequest):
    channel: ContentChannel
    body: str = Field(max_length=10000)
    hashtags: list[Annotated[str, Field(max_length=100)]] = Field(default_factory=list, max_length=60)
    call_to_action: str | None = Field(default=None, max_length=1000)
    fields: dict[str, LongText] = Field(default_factory=dict, max_length=30)
    violations: list[ShortText] = Field(default_factory=list, max_length=50)
    review_reason: str | None = Field(default=None, max_length=2000)


class ImagePromptsContext(_SuggestionRequest):
    title: str = Field(min_length=1, max_length=200)
    brief: ContentBrief
    texts: list[LongText] = Field(default_factory=list, max_length=3)
    used_prompts: list[LongText] = Field(default_factory=list, max_length=10)


class BriefCompletionContext(_SuggestionRequest):
    topic: str = Field(min_length=1, max_length=4000)
    title: str | None = Field(default=None, max_length=200)
    audience: str | None = Field(default=None, max_length=1000)
    objective: str | None = Field(default=None, max_length=1000)
    notes: str | None = Field(default=None, max_length=4000)
    channels: list[ContentChannel] = Field(min_length=1, max_length=4)


class PlannedTopic(WireModel):
    title: str = Field(min_length=1, max_length=500)
    details: str | None = Field(default=None, max_length=2000)


class ContentIdeasContext(_SuggestionRequest):
    recent_titles: list[Annotated[str, Field(max_length=200)]] = Field(default_factory=list, max_length=30)
    planned_topics: list[PlannedTopic] = Field(default_factory=list, max_length=10)
    channels: list[ContentChannel] = Field(min_length=1, max_length=4)


SuggestionContext = RewriteContext | ImagePromptsContext | BriefCompletionContext | ContentIdeasContext


# --- What the model answers (loose; cleaned by sanitize) ------------------------------------


class RawInstruction(BaseModel):
    text: str = ""


class RawInstructions(BaseModel):
    suggestions: list[RawInstruction] = Field(default_factory=list)


class RawImagePrompt(BaseModel):
    label: str = ""
    prompt: str = ""


class RawImagePrompts(BaseModel):
    suggestions: list[RawImagePrompt] = Field(default_factory=list)


class RawBriefCompletion(BaseModel):
    title: str = ""
    audience: str = ""
    objective: str = ""
    notes: str = ""
    fact_ids: list[str] = Field(default_factory=list)
    channels: list[str] = Field(default_factory=list)


class RawIdea(BaseModel):
    title: str = ""
    topic: str = ""
    angle: str = ""
    channels: list[str] = Field(default_factory=list)


class RawIdeas(BaseModel):
    suggestions: list[RawIdea] = Field(default_factory=list)
