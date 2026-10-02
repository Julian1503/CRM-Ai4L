"""The publisher seam, split in two phases to make duplicate posts impossible by design.

WRCC's publishers had one ``publish()``; its Facebook 0/1-image path wrapped the call
that makes the post public in a retry helper, so a 5xx or code-1 answer *after* the post
was created could post it again. Here every publisher has:

``prepare(request, checkpoint) -> dict``
    Private, repeatable scaffolding: unpublished Facebook photos, Instagram containers,
    LinkedIn image URNs. Retried on ``rate_limited``/``transient``. Returns IDs the
    worker checkpoints, and accepts a previous checkpoint to resume from.

``dispatch(request, prepared) -> PublishResult``
    The single call with a public effect. Never retried. It raises
    ``DispatchRejected`` only when the network provably refused (a structured 4xx
    error); anything ambiguous — 5xx, timeout, non-JSON body, success without an id —
    raises ``DispatchUncertain``, which the worker reports as ``uncertain``.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

from app.contracts import SocialAuthorKind, SocialPlatform, SocialProvider

PublishErrorCode = Literal[
    "reauth",
    "rate_limited",
    "transient",
    "invalid",
    "unreachable_media",
    "not_configured",
]


class PublishError(RuntimeError):
    """A prepare-phase failure. Nothing public has happened."""

    def __init__(self, message: str, *, code: PublishErrorCode = "transient") -> None:
        super().__init__(message)
        self.code: PublishErrorCode = code


class DispatchRejected(RuntimeError):
    """The public call was refused with a structured error: nothing went live."""

    def __init__(self, message: str, *, code: str) -> None:
        super().__init__(message)
        self.code = code


class DispatchUncertain(RuntimeError):
    """The public call may have succeeded. Must never be retried automatically."""

    def __init__(
        self, message: str, *, code: str = "ambiguous", provider_request_id: str | None = None
    ) -> None:
        super().__init__(message)
        self.code = code
        self.provider_request_id = provider_request_id


@dataclass(frozen=True, slots=True)
class ResolvedAccount:
    id: str
    provider: SocialProvider
    external_id: str
    author_kind: SocialAuthorKind
    display_name: str
    access_token: str = field(repr=False)


@dataclass(frozen=True, slots=True)
class OutgoingImage:
    """A publicly fetchable image (content-public Storage URL) and its alt text."""

    url: str
    alt: str
    mime_type: str
    width: int
    height: int


@dataclass(frozen=True, slots=True)
class PublishRequest:
    platform: SocialPlatform
    text: str
    account: ResolvedAccount
    images: tuple[OutgoingImage, ...] = ()
    link: str | None = None

    def fingerprint(self) -> str:
        """Identifies the prepared scaffolding: reuse a checkpoint only for the same post."""
        material = "|".join(
            [self.platform, self.account.id, self.text, *[image.url for image in self.images]]
        )
        return hashlib.sha256(material.encode("utf-8")).hexdigest()[:32]


@dataclass(frozen=True, slots=True)
class PublishResult:
    external_id: str
    permalink: str | None = None
    provider_request_id: str | None = None


class Publisher(Protocol):
    async def prepare(self, request: PublishRequest, checkpoint: dict[str, Any]) -> dict[str, Any]: ...

    async def dispatch(self, request: PublishRequest, prepared: dict[str, Any]) -> PublishResult: ...


PREPARED_KEY = "prepared"


def reuse_prepared(request: PublishRequest, checkpoint: dict[str, Any]) -> dict[str, Any] | None:
    """The checkpointed scaffolding, if it was built for exactly this post."""
    saved = checkpoint.get(PREPARED_KEY)
    if isinstance(saved, dict) and saved.get("fingerprint") == request.fingerprint():
        return saved
    return None


def prepared_payload(request: PublishRequest, **ids: Any) -> dict[str, Any]:
    return {"fingerprint": request.fingerprint(), "platform": request.platform, **ids}
