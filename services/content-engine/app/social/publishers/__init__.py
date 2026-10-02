"""Publisher selection: mock unless PUBLISH_MOCK=false (and never live for provider 'mock')."""

from __future__ import annotations

import httpx

from app.config import Settings
from app.contracts import SocialPlatform, SocialProvider
from app.social.publishers.base import Publisher
from app.social.publishers.common import PublisherConfig
from app.social.publishers.facebook import FacebookPublisher
from app.social.publishers.instagram import InstagramPublisher
from app.social.publishers.linkedin import LinkedInPublisher
from app.social.publishers.mock import MockPublisher

_LIVE: dict[str, type[FacebookPublisher | InstagramPublisher | LinkedInPublisher]] = {
    "facebook": FacebookPublisher,
    "instagram": InstagramPublisher,
    "linkedin": LinkedInPublisher,
}


def get_publisher(
    platform: SocialPlatform,
    provider: SocialProvider,
    settings: Settings,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> Publisher:
    if settings.publish_mock or provider == "mock":
        return MockPublisher(platform)
    return _LIVE[platform](PublisherConfig.from_settings(settings), transport=transport)
