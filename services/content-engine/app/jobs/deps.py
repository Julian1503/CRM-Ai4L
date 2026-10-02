"""What handlers need, injected so tests can swap every network edge."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

import httpx

from app.config import Settings
from app.contracts import SocialPlatform, SocialProvider
from app.generation.images import ImageClient, get_image_client
from app.generation.llm import LLMClient, get_llm_client
from app.generation.reference import FetchLimits, Resolver, system_resolver
from app.media.storage import StorageClient
from app.social.publishers import get_publisher
from app.social.publishers.base import Publisher

PublisherFactory = Callable[[SocialPlatform, SocialProvider], Publisher]


@dataclass
class Deps:
    settings: Settings
    llm: LLMClient
    image_client: Callable[[], ImageClient]
    storage: StorageClient
    publisher_for: PublisherFactory
    reference_resolver: Resolver = system_resolver
    reference_transport: httpx.AsyncBaseTransport | None = None

    @property
    def fetch_limits(self) -> FetchLimits:
        s = self.settings
        return FetchLimits(
            timeout_seconds=s.reference_fetch_timeout_seconds,
            max_bytes=s.reference_fetch_max_bytes,
            max_chars=s.reference_fetch_max_chars,
            max_redirects=s.reference_fetch_max_redirects,
            user_agent=s.reference_user_agent,
        )


def build_deps(settings: Settings) -> Deps:
    return Deps(
        settings=settings,
        llm=get_llm_client(settings),
        image_client=lambda: get_image_client(settings),
        storage=StorageClient(
            allow_http=settings.storage_allow_http, timeout=settings.storage_timeout_seconds
        ),
        publisher_for=lambda platform, provider: get_publisher(platform, provider, settings),
    )
