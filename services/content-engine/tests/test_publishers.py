"""Live publishers against scripted transports: prepare is retryable, dispatch runs once.

Rewrites the WRCC tests that asserted the unsafe behaviour
(``test_facebook_retries_a_throttled_call_then_succeeds``,
``test_facebook_transient_graph_code_is_retryable``): throttling and transient errors
are now retried only while preparing; on the public call they are a rejection or an
uncertain outcome, and the call is made exactly once.
"""

from __future__ import annotations

import json
from urllib.parse import parse_qs

import httpx
import pytest

from app.social.publishers.base import (
    DispatchRejected,
    DispatchUncertain,
    OutgoingImage,
    PublishError,
    PublishRequest,
    ResolvedAccount,
)
from app.social.publishers.common import PublisherConfig
from app.social.publishers.facebook import FacebookPublisher
from app.social.publishers.instagram import InstagramPublisher
from app.social.publishers.linkedin import LinkedInPublisher, author_urn, escape_commentary

CONFIG = PublisherConfig(
    graph_base_url="https://graph.test/v23.0",
    timeout=5,
    max_attempts=3,
    retry_base_delay=0,
    instagram_poll_attempts=3,
    instagram_poll_delay=0,
    linkedin_api_version="202506",
    max_image_bytes=1_000_000,
)
TOKEN = "PAGE-TOKEN-not-real"


def _request(
    platform: str, images: int = 0, *, author_kind: str = "page", link: str | None = None
) -> PublishRequest:
    return PublishRequest(
        platform=platform,  # type: ignore[arg-type]
        text="Automating invoices saves hours. (Really!) #AI4L",
        account=ResolvedAccount(
            id="acct-1",
            provider="meta",
            external_id="page-1",
            author_kind=author_kind,  # type: ignore[arg-type]
            display_name="AI4L",
            access_token=TOKEN,
        ),
        images=tuple(
            OutgoingImage(
                url=f"https://cdn.test/img-{i}.jpg",
                alt=f"image {i}",
                mime_type="image/jpeg",
                width=1080,
                height=1080,
            )
            for i in range(images)
        ),
        link=link,
    )


def _form(request: httpx.Request) -> dict[str, str]:
    return {k: v[0] for k, v in parse_qs(request.content.decode()).items()}


def graph_error(code: int, status: int = 400) -> httpx.Response:
    return httpx.Response(status, json={"error": {"message": f"error {code}", "code": code}})


# ── Facebook ──


def facebook(feed: list[httpx.Response], photos: list[httpx.Response] | None = None):  # noqa: ANN201
    calls: list[httpx.Request] = []
    photo_queue = list(photos or [])
    feed_queue = list(feed)

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.path.endswith("/photos"):
            return (
                photo_queue.pop(0) if photo_queue else httpx.Response(200, json={"id": f"photo-{len(calls)}"})
            )
        return feed_queue.pop(0)

    return FacebookPublisher(CONFIG, transport=httpx.MockTransport(handler)), calls


async def test_facebook_single_image_is_an_unpublished_photo_then_one_feed_call() -> None:
    publisher, calls = facebook([httpx.Response(200, json={"id": "page-1_story"})])
    request = _request("facebook", images=1)

    prepared = await publisher.prepare(request, {})
    result = await publisher.dispatch(request, prepared)

    photo, feed = calls
    assert _form(photo)["published"] == "false" and _form(photo)["url"] == "https://cdn.test/img-0.jpg"
    assert json.loads(_form(feed)["attached_media[0]"]) == {"media_fbid": prepared["photoIds"][0]}
    assert result.external_id == "page-1_story"
    assert result.permalink == "https://www.facebook.com/page-1_story"


async def test_facebook_text_post_carries_the_link() -> None:
    publisher, calls = facebook([httpx.Response(200, json={"id": "s"})])
    request = _request("facebook", link="https://ai4l.example/x")
    await publisher.dispatch(request, await publisher.prepare(request, {}))
    assert _form(calls[0])["link"] == "https://ai4l.example/x"


async def test_facebook_retries_throttled_photo_uploads_while_preparing() -> None:
    publisher, calls = facebook([], photos=[graph_error(4), graph_error(2)])
    prepared = await publisher.prepare(_request("facebook", images=1), {})
    assert len(prepared["photoIds"]) == 1
    assert len(calls) == 3


@pytest.mark.parametrize(
    ("response", "expected"),
    [
        (graph_error(4), DispatchRejected),  # throttled: refused, nothing posted, NOT retried
        (graph_error(190, 401), DispatchRejected),
        (graph_error(100), DispatchRejected),
        (graph_error(1, 500), DispatchUncertain),  # "unknown error": may have posted
        (httpx.Response(502, content=b"<html>bad gateway</html>"), DispatchUncertain),
        (httpx.Response(500, json={}), DispatchUncertain),
        (httpx.Response(200, json={}), DispatchUncertain),  # success without an id
    ],
)
async def test_facebook_feed_call_runs_exactly_once(response: httpx.Response, expected: type) -> None:
    publisher, calls = facebook([response, httpx.Response(200, json={"id": "second"})])
    request = _request("facebook")
    with pytest.raises(expected):
        await publisher.dispatch(request, await publisher.prepare(request, {}))
    assert len([c for c in calls if c.url.path.endswith("/feed")]) == 1


async def test_a_dispatch_timeout_is_uncertain() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    publisher = FacebookPublisher(CONFIG, transport=httpx.MockTransport(handler))
    with pytest.raises(DispatchUncertain):
        await publisher.dispatch(_request("facebook"), {"photoIds": []})


async def test_a_failed_connect_on_dispatch_is_a_rejection() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    publisher = FacebookPublisher(CONFIG, transport=httpx.MockTransport(handler))
    with pytest.raises(DispatchRejected):
        await publisher.dispatch(_request("facebook"), {"photoIds": []})


async def test_facebook_reuses_a_checkpoint_for_the_same_post_only() -> None:
    publisher, calls = facebook([])
    request = _request("facebook", images=2)
    first = await publisher.prepare(request, {})
    assert await publisher.prepare(request, {"prepared": first}) == first
    uploads = len(calls)
    other = _request("facebook", images=1)
    await publisher.prepare(other, {"prepared": first})
    assert len(calls) == uploads + 1


async def test_errors_never_carry_the_token() -> None:
    publisher, _calls = facebook(
        [],
        photos=[
            httpx.Response(400, json={"error": {"message": f"bad url ?access_token={TOKEN}", "code": 100}})
        ],
    )
    with pytest.raises(PublishError) as caught:
        await publisher.prepare(_request("facebook", images=1), {})
    assert TOKEN not in str(caught.value)


# ── Instagram ──


def instagram(publish: list[httpx.Response], container_errors: list[httpx.Response] | None = None):  # noqa: ANN201
    calls: list[httpx.Request] = []
    errors = list(container_errors or [])
    publish_queue = list(publish)

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        path = request.url.path
        if path.endswith("/media_publish"):
            return publish_queue.pop(0)
        if path.endswith("/media"):
            return errors.pop(0) if errors else httpx.Response(200, json={"id": f"c{len(calls)}"})
        if request.url.params.get("fields") == "permalink":
            return httpx.Response(200, json={"permalink": "https://www.instagram.com/p/x/"})
        return httpx.Response(200, json={"status_code": "FINISHED"})

    return InstagramPublisher(CONFIG, transport=httpx.MockTransport(handler)), calls


async def test_instagram_carousel_builds_children_then_parent_and_publishes_once() -> None:
    publisher, calls = instagram([httpx.Response(200, json={"id": "media-1"})])
    request = _request("instagram", images=3, author_kind="instagram_business")
    prepared = await publisher.prepare(request, {})
    result = await publisher.dispatch(request, prepared)
    creates = [_form(c) for c in calls if c.url.path.endswith("/media")]
    assert [c.get("is_carousel_item") for c in creates] == ["true", "true", "true", None]
    assert creates[-1]["media_type"] == "CAROUSEL"
    assert result.external_id == "media-1" and result.permalink == "https://www.instagram.com/p/x/"


async def test_instagram_throttled_container_is_retried_but_publish_is_not() -> None:
    publisher, calls = instagram([graph_error(4), httpx.Response(200, json={"id": "late"})], [graph_error(4)])
    request = _request("instagram", images=1, author_kind="instagram_business")
    prepared = await publisher.prepare(request, {})
    with pytest.raises(DispatchRejected):
        await publisher.dispatch(request, prepared)
    assert len([c for c in calls if c.url.path.endswith("/media_publish")]) == 1


async def test_instagram_publish_without_media_id_is_uncertain() -> None:
    publisher, _calls = instagram([httpx.Response(200, json={})])
    request = _request("instagram", images=1, author_kind="instagram_business")
    with pytest.raises(DispatchUncertain):
        await publisher.dispatch(request, await publisher.prepare(request, {}))


async def test_instagram_requires_an_image() -> None:
    publisher, _calls = instagram([])
    with pytest.raises(PublishError):
        await publisher.prepare(_request("instagram"), {})


# ── LinkedIn ──


def linkedin(post: list[httpx.Response], uploads: list[httpx.Response] | None = None):  # noqa: ANN201
    calls: list[httpx.Request] = []
    post_queue = list(post)
    upload_queue = list(uploads or [])

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.host == "cdn.test":
            return httpx.Response(200, content=b"\xff\xd8\xffjpeg")
        if "initializeUpload" in str(request.url):
            if upload_queue:
                return upload_queue.pop(0)
            n = len(calls)
            return httpx.Response(
                200, json={"value": {"uploadUrl": f"https://up.test/{n}", "image": f"urn:li:image:{n}"}}
            )
        if request.url.host == "up.test":
            return httpx.Response(201)
        return post_queue.pop(0)

    return LinkedInPublisher(CONFIG, transport=httpx.MockTransport(handler)), calls


def test_author_is_explicit_per_connection() -> None:
    assert author_urn("organization", "42") == "urn:li:organization:42"
    assert author_urn("member", "abc") == "urn:li:person:abc"
    with pytest.raises(PublishError):
        author_urn("page", "42")


def test_commentary_escaping() -> None:
    assert escape_commentary("Hi (you) #tag") == "Hi \\(you\\) \\#tag"


async def test_linkedin_multi_image_post_is_created_once_with_versioned_headers() -> None:
    publisher, calls = linkedin([httpx.Response(201, headers={"x-restli-id": "urn:li:share:1"})])
    request = _request("linkedin", images=2, author_kind="organization")
    prepared = await publisher.prepare(request, {})
    result = await publisher.dispatch(request, prepared)
    post = [c for c in calls if c.url.path == "/rest/posts"][0]
    body = json.loads(post.content)
    assert body["author"] == "urn:li:organization:page-1"
    assert [i["id"] for i in body["content"]["multiImage"]["images"]] == prepared["imageUrns"]
    assert post.headers["LinkedIn-Version"] == "202506"
    assert result.external_id == "urn:li:share:1"


async def test_linkedin_retries_an_upload_but_posts_once() -> None:
    publisher, calls = linkedin(
        [httpx.Response(201, headers={"x-restli-id": "urn:li:share:2"})],
        uploads=[httpx.Response(429, json={})],
    )
    request = _request("linkedin", images=1, author_kind="member")
    await publisher.dispatch(request, await publisher.prepare(request, {}))
    assert len([c for c in calls if "initializeUpload" in str(c.url)]) == 2
    assert len([c for c in calls if c.url.path == "/rest/posts"]) == 1


@pytest.mark.parametrize(
    ("response", "expected"),
    [
        (httpx.Response(201), DispatchUncertain),  # no id header
        (httpx.Response(503, json={}), DispatchUncertain),
        (httpx.Response(429, json={}), DispatchRejected),
        (httpx.Response(422, json={"message": "bad"}), DispatchRejected),
        (httpx.Response(401, json={}), DispatchRejected),
    ],
)
async def test_linkedin_post_outcomes(response: httpx.Response, expected: type) -> None:
    publisher, calls = linkedin([response, httpx.Response(201, headers={"x-restli-id": "x"})])
    request = _request("linkedin", author_kind="organization")
    with pytest.raises(expected):
        await publisher.dispatch(request, await publisher.prepare(request, {}))
    assert len([c for c in calls if c.url.path == "/rest/posts"]) == 1
