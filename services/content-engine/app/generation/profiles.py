"""Per-channel generation profiles and the deterministic validation baseline.

Ported from WRCC ``agents/content_generator.PLATFORM_PROFILES`` and
``agents/validation.py``. The WRCC tone/CTA/structure strings are gone: tone, CTA and
structure now come from the brand profile in the job context, and the hard ceilings come
from the CRM's ``platformLimits``. What stays here are neutral style defaults (how long a
post on each network usually reads well), which the CRM limits can only tighten.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.contracts import BrandProfile, ContentChannel, PlatformLimits

VARIANT_STYLES: tuple[str, ...] = ("direct", "story_led", "question_led")

EMAIL_FIELD_LIMITS: dict[str, int] = {
    "subject": 90,
    "preheader": 120,
    "headline": 80,
    "intro": 320,
    "body": 1200,
    "ctaLabel": 28,
}


@dataclass(frozen=True, slots=True)
class ChannelProfile:
    channel: ContentChannel
    tone: str
    cta: str | None
    structure: str
    min_length: int
    max_length: int
    hashtags_min: int
    hashtags_max: int

    def as_context(self) -> dict:
        return {
            "channel": self.channel,
            "tone": self.tone,
            "cta": self.cta,
            "structure": self.structure,
            "min_length": self.min_length,
            "max_length": self.max_length,
            "hashtags_min": self.hashtags_min,
            "hashtags_max": self.hashtags_max,
        }


# (min_length, max_length, hashtags_min, hashtags_max, default structure)
_DEFAULTS: dict[str, tuple[int, int, int, int, str]] = {
    "linkedin": (600, 1300, 3, 5, "hook + value + proof point + call to action"),
    "facebook": (250, 600, 2, 5, "hook + benefit + practical detail + call to action"),
    "instagram": (125, 400, 8, 15, "short hook + a few emojis + call to action + hashtags"),
    "email": (200, EMAIL_FIELD_LIMITS["body"], 0, 0, "headline + short intro + body + one call to action"),
}


def profile_for(
    channel: ContentChannel, brand: BrandProfile, limits: PlatformLimits | None
) -> ChannelProfile:
    """Neutral defaults, overridden by the brand's channel rule and capped by CRM limits."""
    min_length, max_length, tags_min, tags_max, structure = _DEFAULTS[channel]
    if limits is not None:
        max_length = min(max_length, limits.max_chars)
        tags_max = min(tags_max, limits.max_hashtags)
    tags_min = min(tags_min, tags_max)
    min_length = min(min_length, max_length)
    rule = brand.channel_rules.get(channel)
    return ChannelProfile(
        channel=channel,
        tone=brand.tone,
        cta=(rule.cta if rule and rule.cta else None),
        structure=(rule.structure if rule and rule.structure else structure),
        min_length=min_length,
        max_length=max_length,
        hashtags_min=tags_min,
        hashtags_max=tags_max,
    )


_URL_RE = re.compile(r"(?i)\b(?:https?://|www\.)[^\s)\]>\"']+")


def find_urls(text: str) -> list[str]:
    return _URL_RE.findall(text or "")


def url_allowed(url: str, allowed_origins: list[str]) -> bool:
    candidate = url if "://" in url else f"https://{url}"
    return any(
        candidate.lower().startswith(origin.rstrip("/").lower() + "/")
        or candidate.lower() == origin.rstrip("/").lower()
        for origin in allowed_origins
    )


def validate_social(
    profile: ChannelProfile,
    *,
    body: str,
    hashtags: list[str],
    call_to_action: str | None,
    allowed_origins: list[str],
) -> list[str]:
    """Profile violations (empty = compliant). Informational: used to rank variants."""
    violations: list[str] = []
    length = len(body or "")
    if length < profile.min_length:
        violations.append(f"body too short for {profile.channel} ({length} < {profile.min_length} chars)")
    elif length > profile.max_length:
        violations.append(f"body too long for {profile.channel} ({length} > {profile.max_length} chars)")
    count = len(hashtags or [])
    if count < profile.hashtags_min:
        violations.append(f"too few hashtags ({count} < {profile.hashtags_min})")
    elif count > profile.hashtags_max:
        violations.append(f"too many hashtags ({count} > {profile.hashtags_max})")
    if not (call_to_action or "").strip():
        violations.append("missing call to action")
    violations.extend(_link_violations(" ".join([body or "", call_to_action or ""]), allowed_origins))
    return violations


def validate_email(fields: dict[str, str], *, allowed_origins: list[str]) -> list[str]:
    violations: list[str] = []
    for name, limit in EMAIL_FIELD_LIMITS.items():
        value = fields.get(name, "")
        if not value.strip():
            violations.append(f"email {name} is empty")
        elif len(value) > limit:
            violations.append(f"email {name} too long ({len(value)} > {limit} chars)")
    joined = " ".join(fields.values())
    if "#" in fields.get("body", "") and re.search(r"(?<!\w)#\w", fields.get("body", "")):
        violations.append("email body contains hashtags")
    violations.extend(_link_violations(joined, allowed_origins))
    return violations


def _link_violations(text: str, allowed_origins: list[str]) -> list[str]:
    return [
        f"blocked:link {url} is not an allowed destination"
        for url in find_urls(text)
        if not url_allowed(url, allowed_origins)
    ]
