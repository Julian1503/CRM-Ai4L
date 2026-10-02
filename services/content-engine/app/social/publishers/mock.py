"""Deterministic offline publisher (PUBLISH_MOCK=true, the default)."""

from __future__ import annotations

import hashlib
from typing import Any

from app.contracts import SocialPlatform
from app.social.publishers.base import PublishRequest, PublishResult, prepared_payload

_PERMALINKS: dict[SocialPlatform, str] = {
    "facebook": "https://www.facebook.com/{post_id}",
    "instagram": "https://www.instagram.com/p/{post_id}/",
    "linkedin": "https://www.linkedin.com/feed/update/{post_id}",
}


class MockPublisher:
    def __init__(self, platform: SocialPlatform) -> None:
        self._platform = platform

    async def prepare(self, request: PublishRequest, checkpoint: dict[str, Any]) -> dict[str, Any]:
        return prepared_payload(request, mock=True, imageCount=len(request.images))

    async def dispatch(self, request: PublishRequest, prepared: dict[str, Any]) -> PublishResult:
        digest = hashlib.sha256(
            f"{self._platform}|{request.account.external_id}|{request.text}".encode()
        ).hexdigest()[:16]
        post_id = f"mock_{request.account.external_id}_{digest}"
        return PublishResult(
            external_id=post_id,
            permalink=_PERMALINKS[self._platform].format(post_id=post_id),
            provider_request_id=f"mock-{digest}",
        )
