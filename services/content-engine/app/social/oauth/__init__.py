"""OAuth provider selection: mock unless PUBLISH_MOCK=false; 'mock' is always mock."""

from __future__ import annotations

import httpx

from app.config import Settings
from app.contracts import SocialProvider
from app.social.oauth.base import OAuthProvider
from app.social.oauth.linkedin import LinkedInOAuthProvider
from app.social.oauth.meta import MetaOAuthProvider
from app.social.oauth.mock import MockOAuthProvider


def get_oauth_provider(
    provider: SocialProvider, settings: Settings, *, transport: httpx.AsyncBaseTransport | None = None
) -> OAuthProvider:
    if settings.publish_mock or provider == "mock":
        return MockOAuthProvider(provider)
    if provider == "meta":
        return MetaOAuthProvider(settings, transport=transport)
    return LinkedInOAuthProvider(settings, transport=transport)
