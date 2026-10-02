"""Publish to a Facebook Page. Ported from WRCC ``publishers/facebook.py``, restructured.

prepare: each image is uploaded ``published=false`` from its public URL (private
scaffolding, repeatable, expires on its own). Retried on throttling/transient errors.

dispatch: ONE ``POST /{page}/feed`` — with ``attached_media`` when there are images,
with ``link`` for a text post. This replaces WRCC's 0/1-image path, which posted the
photo with its caption through ``/photos`` inside the retry helper.
"""

from __future__ import annotations

import json
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


def permalink_for(post_id: str) -> str:
    return f"https://www.facebook.com/{post_id}"


class FacebookPublisher:
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
        saved = reuse_prepared(request, checkpoint)
        if saved is not None and len(saved.get("photoIds", [])) == len(request.images):
            return saved
        if not request.images:
            return prepared_payload(request, photoIds=[])
        photo_ids = await with_retries(
            lambda: self._upload_unpublished(request),
            attempts=self._config.max_attempts,
            base_delay=self._config.retry_base_delay,
            description="Facebook photo upload",
        )
        return prepared_payload(request, photoIds=photo_ids)

    async def _upload_unpublished(self, request: PublishRequest) -> list[str]:
        client = self._client(request.account.access_token)
        photo_ids: list[str] = []
        try:
            for index, image in enumerate(request.images):
                payload = await client.post(
                    f"/{request.account.external_id}/photos",
                    data={"url": image.url, "published": "false", "alt_text_custom": image.alt or ""},
                )
                photo_id = payload.get("id")
                if not photo_id:
                    raise PublishError(
                        f"Facebook did not return an id for image {index + 1}.", code="transient"
                    )
                photo_ids.append(str(photo_id))
        except MetaGraphError as exc:
            raise graph_prepare_error(exc) from exc
        return photo_ids

    async def dispatch(self, request: PublishRequest, prepared: dict[str, Any]) -> PublishResult:
        """The one call that puts the post on the Page. Never retried."""
        client = self._client(request.account.access_token)
        data: dict[str, str] = {"message": request.text}
        photo_ids = list(prepared.get("photoIds") or [])
        for index, photo_id in enumerate(photo_ids):
            # Graph reads attached_media[0], attached_media[1]… as indexed form fields.
            data[f"attached_media[{index}]"] = json.dumps({"media_fbid": photo_id})
        if not photo_ids and request.link:
            data["link"] = request.link

        async def call() -> dict:
            try:
                return await client.post(f"/{request.account.external_id}/feed", data=data)
            except MetaGraphError as exc:
                raise graph_dispatch_error(exc) from None

        payload = await guard_dispatch_transport(call)
        post_id = payload.get("id")
        if not post_id:
            raise DispatchUncertain(
                "Facebook accepted the post but returned no id, so it is probably live and we cannot "
                "link to it. Check the Page before publishing again.",
            )
        return PublishResult(external_id=str(post_id), permalink=permalink_for(str(post_id)))
