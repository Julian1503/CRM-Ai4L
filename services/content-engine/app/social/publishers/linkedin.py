"""Publish to a LinkedIn organization page or member profile.

Ported from WRCC ``publishers/linkedin.py``. Changes:

* the author is explicit per connection (``authorKind`` organization|member); there is
  no global ``LINKEDIN_AUTHOR_URN`` and no fallback from a page to a personal profile;
* prepare downloads each image from its public URL and uploads it (initializeUpload +
  PUT), retried per image, checkpointed as ``imageUrns``;
* dispatch is ONE ``POST /rest/posts``: a 4xx is a definitive rejection, while a 5xx,
  a transport error or a 2xx without ``x-restli-id`` is uncertain.

``LinkedIn-Version`` (LINKEDIN_API_VERSION, default 202506) must be revalidated before
going live; LinkedIn retires old versions.
"""

from __future__ import annotations

from functools import partial
from typing import Any

import httpx

from app.social.publishers.base import (
    DispatchRejected,
    DispatchUncertain,
    PublishError,
    PublishErrorCode,
    PublishRequest,
    PublishResult,
    prepared_payload,
    reuse_prepared,
)
from app.social.publishers.common import PublisherConfig, guard_dispatch_transport
from app.social.publishers.retry import with_retries

API_BASE = "https://api.linkedin.com"

# LinkedIn's "little text" format reserves these; each must be backslash-escaped.
_RESERVED = set("\\|{}@[]()<>#*_~")


def escape_commentary(text: str) -> str:
    return "".join(f"\\{char}" if char in _RESERVED else char for char in text)


def permalink_for(post_urn: str) -> str:
    return f"https://www.linkedin.com/feed/update/{post_urn}"


def author_urn(author_kind: str, external_id: str) -> str:
    if author_kind == "organization":
        return f"urn:li:organization:{external_id}"
    if author_kind == "member":
        return f"urn:li:person:{external_id}"
    raise PublishError(f"LinkedIn cannot post as a '{author_kind}' account.", code="invalid")


def _detail(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        return ""
    if not isinstance(payload, dict):
        return ""
    return str(payload.get("message") or payload.get("error_description") or "")[:300]


def prepare_error(response: httpx.Response, stage: str) -> PublishError:
    suffix = f" {_detail(response)}".rstrip()
    if response.status_code in (401, 403):
        return PublishError(
            f"LinkedIn rejected the credentials.{suffix} Reconnect the account.", code="reauth"
        )
    if response.status_code == 429:
        return PublishError(f"LinkedIn is rate limiting this app.{suffix}", code="rate_limited")
    if response.status_code >= 500:
        return PublishError(
            f"LinkedIn could not {stage} (HTTP {response.status_code}).{suffix}", code="transient"
        )
    return PublishError(f"LinkedIn refused to {stage} (HTTP {response.status_code}).{suffix}", code="invalid")


class LinkedInPublisher:
    def __init__(self, config: PublisherConfig, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._config = config
        self._transport = transport

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            transport=self._transport, timeout=self._config.timeout, follow_redirects=False
        )

    def _headers(self, token: str) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {token}",
            "LinkedIn-Version": self._config.linkedin_api_version,
            "X-Restli-Protocol-Version": "2.0.0",
        }

    async def prepare(self, request: PublishRequest, checkpoint: dict[str, Any]) -> dict[str, Any]:
        author = author_urn(request.account.author_kind, request.account.external_id)
        saved = reuse_prepared(request, checkpoint)
        if saved is not None and len(saved.get("imageUrns", [])) == len(request.images):
            return saved
        urns: list[str] = []
        for index, image in enumerate(request.images):
            urns.append(
                await with_retries(
                    partial(self._upload_image, image.url, owner=author, token=request.account.access_token),
                    attempts=self._config.max_attempts,
                    base_delay=self._config.retry_base_delay,
                    description=f"LinkedIn image {index + 1} upload",
                )
            )
        return prepared_payload(request, author=author, imageUrns=urns)

    async def _download(self, client: httpx.AsyncClient, url: str) -> bytes:
        if not url.startswith("https://"):
            raise PublishError("Images must be served over https.", code="unreachable_media")
        async with client.stream("GET", url) as response:
            if response.is_error:
                code: PublishErrorCode = "transient" if response.status_code >= 500 else "unreachable_media"
                raise PublishError(f"Could not fetch an image (HTTP {response.status_code}).", code=code)
            data = b""
            async for chunk in response.aiter_bytes():
                data += chunk
                if len(data) > self._config.max_image_bytes:
                    raise PublishError("An image is too large to upload.", code="invalid")
            return data

    async def _upload_image(self, url: str, *, owner: str, token: str) -> str:
        async with self._client() as client:
            image = await self._download(client, url)
            initialized = await client.post(
                f"{API_BASE}/rest/images?action=initializeUpload",
                json={"initializeUploadRequest": {"owner": owner}},
                headers=self._headers(token),
            )
            if initialized.is_error:
                raise prepare_error(initialized, "start the image upload")
            try:
                value = initialized.json().get("value") or {}
            except ValueError:
                raise PublishError(
                    "LinkedIn returned an unreadable upload response.", code="transient"
                ) from None
            upload_url, image_urn = value.get("uploadUrl"), value.get("image")
            if not upload_url or not image_urn:
                raise PublishError("LinkedIn did not return an image upload target.", code="transient")
            uploaded = await client.put(
                str(upload_url),
                content=image,
                headers={"Authorization": f"Bearer {token}", "Content-Type": "image/jpeg"},
            )
        if uploaded.is_error:
            raise prepare_error(uploaded, "upload the image")
        return str(image_urn)

    def _content_for(self, request: PublishRequest, urns: list[str]) -> dict | None:
        if not urns:
            return None
        if len(urns) == 1:
            media: dict = {"id": urns[0]}
            if request.images[0].alt:
                media["altText"] = request.images[0].alt
            return {"media": media}
        images = []
        for urn, image in zip(urns, request.images, strict=True):
            entry: dict = {"id": urn}
            if image.alt:
                entry["altText"] = image.alt
            images.append(entry)
        return {"multiImage": {"images": images}}

    async def dispatch(self, request: PublishRequest, prepared: dict[str, Any]) -> PublishResult:
        """Create the post. Called once, never retried."""
        urns = list(prepared.get("imageUrns") or [])
        body: dict = {
            "author": author_urn(request.account.author_kind, request.account.external_id),
            "commentary": escape_commentary(request.text),
            "visibility": "PUBLIC",
            "distribution": {
                "feedDistribution": "MAIN_FEED",
                "targetEntities": [],
                "thirdPartyDistributionChannels": [],
            },
            "lifecycleState": "PUBLISHED",
            "isReshareDisabledByAuthor": False,
        }
        content = self._content_for(request, urns)
        if content is not None:
            body["content"] = content

        async def call() -> httpx.Response:
            async with self._client() as client:
                return await client.post(
                    f"{API_BASE}/rest/posts", json=body, headers=self._headers(request.account.access_token)
                )

        response = await guard_dispatch_transport(call)
        request_id = response.headers.get("x-li-uuid")
        if response.status_code >= 500:
            raise DispatchUncertain(
                f"LinkedIn answered HTTP {response.status_code} while creating the post. It may be live.",
                code="provider_ambiguous",
                provider_request_id=request_id,
            )
        if response.is_error:
            code = {401: "reauth", 403: "reauth", 429: "rate_limited"}.get(response.status_code, "invalid")
            raise DispatchRejected(
                f"LinkedIn refused the post (HTTP {response.status_code}). {_detail(response)}".strip(),
                code=code,
            )
        post_urn = response.headers.get("x-restli-id") or response.headers.get("x-linkedin-id")
        if not post_urn:
            raise DispatchUncertain(
                "LinkedIn accepted the post but returned no id, so it is probably live. "
                "Check the page before publishing again.",
                provider_request_id=request_id,
            )
        return PublishResult(
            external_id=post_urn, permalink=permalink_for(post_urn), provider_request_id=request_id
        )
