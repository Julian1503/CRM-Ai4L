"""Publish to an Instagram Business account. Ported from WRCC ``publishers/instagram.py``.

prepare: build the container (one image) or the carousel (children + parent) from public
JPEG URLs, then poll until FINISHED. Repeatable; checkpointed as ``creationId``. On
resume the saved container is re-polled and rebuilt if it expired or errored.

dispatch: ONE ``POST /{ig}/media_publish``. The permalink lookup afterwards is best-effort
and can never turn a published post into a failure.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx

from app.social.meta_graph import GraphClient, MetaGraphError
from app.social.publishers.base import (
    DispatchUncertain,
    PublishError,
    PublishRequest,
    PublishResult,
    prepared_payload,
    reuse_prepared,
)
from app.social.publishers.common import (
    PublisherConfig,
    graph_dispatch_error,
    graph_prepare_error,
    guard_dispatch_transport,
)
from app.social.publishers.retry import with_retries

_DEAD_STATES = frozenset({"ERROR", "EXPIRED"})


class InstagramPublisher:
    def __init__(self, config: PublisherConfig, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._config = config
        self._transport = transport

    def _client(self, token: str) -> GraphClient:
        return GraphClient(
            self._config.graph_base_url,
            timeout=self._config.timeout,
            access_token=token,
            transport=self._transport,
        )

    async def prepare(self, request: PublishRequest, checkpoint: dict[str, Any]) -> dict[str, Any]:
        if not request.images:
            raise PublishError("Instagram posts require an image.", code="invalid")
        saved = reuse_prepared(request, checkpoint)
        if (
            saved is not None
            and saved.get("creationId")
            and await self._still_usable(request, saved["creationId"])
        ):
            return saved
        creation_id = await with_retries(
            lambda: self._build(request),
            attempts=self._config.max_attempts,
            base_delay=self._config.retry_base_delay,
            description="Instagram container",
        )
        return prepared_payload(request, creationId=creation_id)

    async def _still_usable(self, request: PublishRequest, creation_id: str) -> bool:
        try:
            payload = await self._client(request.account.access_token).get(
                f"/{creation_id}", params={"fields": "status_code"}
            )
        except MetaGraphError:
            return False
        return payload.get("status_code") in (None, "FINISHED")

    async def _build(self, request: PublishRequest) -> str:
        client = self._client(request.account.access_token)
        ig_id = request.account.external_id
        try:
            if len(request.images) == 1:
                return await self._container(
                    client, ig_id, {"image_url": request.images[0].url, "caption": request.text}, "the image"
                )
            children = [
                await self._container(
                    client, ig_id, {"image_url": image.url, "is_carousel_item": "true"}, f"image {index + 1}"
                )
                for index, image in enumerate(request.images)
            ]
            return await self._container(
                client,
                ig_id,
                {"media_type": "CAROUSEL", "children": ",".join(children), "caption": request.text},
                "the carousel",
            )
        except MetaGraphError as exc:
            raise graph_prepare_error(exc) from exc

    async def _container(self, client: GraphClient, ig_id: str, data: dict, label: str) -> str:
        created = await client.post(f"/{ig_id}/media", data=data)
        creation_id = created.get("id")
        if not creation_id:
            raise PublishError(f"Instagram did not return a container id for {label}.", code="transient")
        await self._await_container(client, str(creation_id))
        return str(creation_id)

    async def _await_container(self, client: GraphClient, creation_id: str) -> None:
        for attempt in range(self._config.instagram_poll_attempts):
            payload = await client.get(f"/{creation_id}", params={"fields": "status_code"})
            state = payload.get("status_code")
            if state in (None, "FINISHED"):
                return
            if state in _DEAD_STATES:
                raise PublishError(
                    f"Instagram rejected the image while processing it ({state}). "
                    "Check the image meets Instagram's size and ratio rules.",
                    code="invalid",
                )
            if attempt + 1 < self._config.instagram_poll_attempts:
                await asyncio.sleep(self._config.instagram_poll_delay)
        raise PublishError("Instagram did not finish processing the image in time.", code="transient")

    async def dispatch(self, request: PublishRequest, prepared: dict[str, Any]) -> PublishResult:
        """Turn the container into a live post. Called once, never retried."""
        creation_id = prepared.get("creationId")
        if not creation_id:
            raise PublishError("No prepared Instagram container.", code="invalid")
        client = self._client(request.account.access_token)

        async def call() -> dict:
            try:
                return await client.post(
                    f"/{request.account.external_id}/media_publish", data={"creation_id": creation_id}
                )
            except MetaGraphError as exc:
                raise graph_dispatch_error(exc) from None

        published = await guard_dispatch_transport(call)
        media_id = published.get("id")
        if not media_id:
            raise DispatchUncertain(
                "Instagram accepted the post but returned no media id, so it is probably live. "
                "Check the account before publishing again."
            )
        return PublishResult(
            external_id=str(media_id), permalink=await self._permalink(client, str(media_id))
        )

    async def _permalink(self, client: GraphClient, media_id: str) -> str | None:
        try:
            payload = await client.get(f"/{media_id}", params={"fields": "permalink"})
        except (MetaGraphError, httpx.HTTPError):
            return None
        link = payload.get("permalink")
        return str(link) if link and str(link).startswith("https://") else None
