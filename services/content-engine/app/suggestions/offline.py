"""Deterministic suggestions for LLM_MOCK=true: built only from the request's context.

They go through the same sanitiser as live answers, so mock mode exercises the whole
path (dedupe against ``avoid``, fact ids, channels) without a provider.
"""

from __future__ import annotations

from app.suggestions.models import (
    BriefCompletionContext,
    ContentIdeasContext,
    ImagePromptsContext,
    RawBriefCompletion,
    RawIdea,
    RawIdeas,
    RawImagePrompt,
    RawImagePrompts,
    RawInstruction,
    RawInstructions,
    RewriteContext,
)

_REWRITES = (
    "Make it shorter and lead with the key point",
    "Open with a question the audience is asking",
    "End with one clear call to action",
    "Use a warmer, more personal tone",
    "Replace general claims with one concrete example",
    "Cut the hashtags to the three most relevant",
)

_SCENES = (
    ("Team at work", "A small team gathered around a table, working through ideas on paper"),
    ("Close-up detail", "A close-up of hands sketching a plan in a notebook, shallow depth of field"),
    ("Wide setting", "A bright, open workspace seen from a distance, people in soft focus"),
    ("Moment of insight", "One person looking up from a laptop with a calm, focused expression"),
    ("Abstract concept", "An abstract arrangement of simple shapes suggesting connection and growth"),
)

_ANGLES = (
    "A practical how-to",
    "A common mistake and how to avoid it",
    "A short story from the field",
    "Five quick tips",
    "What changes this season",
    "Answering the question we hear most",
)


def _first_line(text: str, limit: int) -> str:
    line = " ".join(text.split())
    return line if len(line) <= limit else line[: limit - 1].rstrip() + "…"


def offline_rewrite(ctx: RewriteContext) -> RawInstructions:
    first = []
    if ctx.review_reason:
        first.append(f"Fix what the reviewer raised: {_first_line(ctx.review_reason, 80)}")
    if ctx.violations:
        first.append(f"Resolve: {_first_line(ctx.violations[0], 100)}")
    return RawInstructions(suggestions=[RawInstruction(text=text) for text in [*first, *_REWRITES]])


def offline_image_prompts(ctx: ImagePromptsContext) -> RawImagePrompts:
    direction = f" {ctx.brand.image_direction.strip()}" if ctx.brand.image_direction.strip() else ""
    topic = _first_line(ctx.brief.topic, 120)
    return RawImagePrompts(
        suggestions=[
            RawImagePrompt(label=label, prompt=f"{scene}, illustrating {topic}.{direction}")
            for label, scene in _SCENES
        ]
    )


def offline_brief_completion(ctx: BriefCompletionContext) -> RawBriefCompletion:
    topic = _first_line(ctx.topic, 70)
    audience = ctx.audience or ctx.brand.audience
    return RawBriefCompletion(
        title=ctx.title or topic,
        audience=audience,
        objective=ctx.objective or f"Get {audience} to ask about {topic}",
        notes=ctx.notes or f"Lead with why {topic} matters now; keep it practical and in the brand's tone.",
        fact_ids=[fact.id for fact in ctx.brand.approved_facts[:2]],
        channels=list(ctx.channels[:2]),
    )


def offline_content_ideas(ctx: ContentIdeasContext) -> RawIdeas:
    seeds = [topic.title for topic in ctx.planned_topics] + [fact.text for fact in ctx.brand.approved_facts]
    seeds = seeds or [ctx.brand.audience]
    ideas = [
        RawIdea(
            title=f"{angle}: {_first_line(seeds[index % len(seeds)], 60)}",
            topic=f"{angle} about {_first_line(seeds[index % len(seeds)], 200)} for {ctx.brand.audience}.",
            angle=f"Useful to {ctx.brand.audience} right now.",
            channels=list(ctx.channels[:2]),
        )
        for index, angle in enumerate(_ANGLES)
    ]
    return RawIdeas(suggestions=ideas)
