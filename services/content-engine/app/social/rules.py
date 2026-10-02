"""Publishing rules — pure. Ported from WRCC ``publishing/rules.py``.

The CRM owns preflight (it knows approval, accounts and pending attempts). The engine
keeps the pure parts so it can re-check, right before dispatch, that what it is about to
send is something the network will accept: the composed-text contract (mirrored by the
CRM in TypeScript and pinned by shared/content-contracts/fixtures/post-text-cases.json)
and the per-network limits.
"""

from __future__ import annotations

from app.contracts import PlatformLimits, PublishImage, SocialPlatform
from app.media.publish_formats import instagram_problems

# Facebook and LinkedIn publish no hashtag ceiling; 100 is ours. Instagram's 30 is real.
LIMITS: dict[SocialPlatform, PlatformLimits] = {
    "facebook": PlatformLimits(max_chars=63_206, max_hashtags=100, max_images=10, requires_image=False),
    "instagram": PlatformLimits(max_chars=2_200, max_hashtags=30, max_images=10, requires_image=True),
    "linkedin": PlatformLimits(max_chars=3_000, max_hashtags=100, max_images=20, requires_image=False),
}

MULTI_IMAGE_FROM = 2


def format_hashtag(tag: str) -> str:
    """Trimmed, with a leading '#' — the database stores tags without it."""
    trimmed = tag.strip()
    return trimmed if trimmed.startswith("#") else f"#{trimmed}"


def compose_post_text(body: str, call_to_action: str | None, hashtags: list[str]) -> str:
    """Body, then CTA, then hashtags — the single blob a network expects."""
    tags = " ".join(format_hashtag(tag) for tag in hashtags if tag.strip())
    sections = [body.strip(), (call_to_action or "").strip(), tags]
    return "\n\n".join(section for section in sections if section)


def content_issues(
    platform: SocialPlatform,
    text: str,
    images: list[PublishImage],
    *,
    hashtag_count: int | None = None,
) -> list[tuple[str, str]]:
    """Blocking (code, message) pairs for what the network would certainly reject.

    Mirrored by the CRM preflight (src/lib/social/preflightRules.ts); both run
    shared/content-contracts/fixtures/preflight-cases.json. Lengths count code points.
    """
    limits = LIMITS[platform]
    issues: list[tuple[str, str]] = []
    if not text.strip():
        issues.append(("text_empty", "The post is empty."))
    elif len(text) > limits.max_chars:
        issues.append(
            ("text_too_long", f"The post is {len(text)} characters; {platform} allows {limits.max_chars}.")
        )
    if hashtag_count is not None and hashtag_count > limits.max_hashtags:
        issues.append(
            ("too_many_hashtags", f"{hashtag_count} hashtags; {platform} allows {limits.max_hashtags}.")
        )
    if limits.requires_image and not images:
        issues.append(("image_required", f"{platform.title()} posts require an image."))
    if len(images) > limits.max_images:
        issues.append(
            ("too_many_images", f"{len(images)} images selected; {platform} accepts {limits.max_images}.")
        )
    if platform == "instagram":
        issues.extend(_instagram_image_issues(images))
    return issues


def _instagram_image_issues(images: list[PublishImage]) -> list[tuple[str, str]]:
    issues: list[tuple[str, str]] = []
    for index, image in enumerate(images):
        prefix = f"Image {index + 1}: " if len(images) > 1 else ""
        if image.mime_type != "image/jpeg":
            issues.append(("image_format", f"{prefix}Instagram only accepts JPEG ({image.mime_type} given)."))
        for problem in instagram_problems(image.width, image.height):
            code = "image_too_small" if "wide;" in problem else "image_aspect"
            issues.append((code, prefix + problem))
    return issues


def dispatch_blockers(platform: SocialPlatform, text: str, images: list[PublishImage]) -> list[str]:
    """Reasons the network would certainly reject this post. Checked before any call."""
    return [message for _code, message in content_issues(platform, text, images)]
