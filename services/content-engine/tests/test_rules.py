"""Publishing rules, ported from WRCC tests/test_publishing_rules.py (shared fixture + limits)."""

from __future__ import annotations

import pytest

from app.contracts import PublishImage
from app.social.rules import LIMITS, compose_post_text, dispatch_blockers
from tests.conftest import load_fixture

CASES = load_fixture("post-text-cases.json")["cases"]


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_compose_matches_the_shared_contract(case: dict) -> None:
    assert compose_post_text(case["body"], case["call_to_action"], case["hashtags"]) == case["expected"]


def _image(width: int = 1080, height: int = 1080, mime: str = "image/jpeg") -> PublishImage:
    return PublishImage(url="https://cdn.test/a.jpg", alt="", mime_type=mime, width=width, height=height)


@pytest.mark.parametrize("platform", ["facebook", "instagram", "linkedin"])
def test_text_at_the_limit_is_allowed_and_one_over_blocks(platform: str) -> None:
    limit = LIMITS[platform].max_chars  # type: ignore[index]
    images = [_image()]
    assert dispatch_blockers(platform, "a" * limit, images) == []  # type: ignore[arg-type]
    assert dispatch_blockers(platform, "a" * (limit + 1), images)  # type: ignore[arg-type]


def test_empty_text_blocks() -> None:
    assert dispatch_blockers("facebook", "  ", []) == ["The post is empty."]


def test_instagram_requires_a_jpeg_image_in_its_accepted_shape() -> None:
    assert dispatch_blockers("instagram", "hi", [])
    assert dispatch_blockers("instagram", "hi", [_image(mime="image/png")])
    assert dispatch_blockers("instagram", "hi", [_image(200, 200)])
    assert dispatch_blockers("instagram", "hi", [_image(3000, 1000)])
    assert dispatch_blockers("instagram", "hi", [_image(1080, 1350)]) == []


@pytest.mark.parametrize("platform", ["facebook", "linkedin"])
def test_image_is_optional_off_instagram(platform: str) -> None:
    assert dispatch_blockers(platform, "hi", []) == []  # type: ignore[arg-type]


def test_too_many_images_block() -> None:
    assert dispatch_blockers("facebook", "hi", [_image()] * 11)
    assert dispatch_blockers("linkedin", "hi", [_image()] * 20) == []


PREFLIGHT_CASES = load_fixture("preflight-cases.json")["cases"]


@pytest.mark.parametrize("case", PREFLIGHT_CASES, ids=lambda case: case["name"])
def test_content_issues_match_the_shared_preflight_contract(case: dict) -> None:
    from app.social.rules import content_issues

    images = [_image(i["width"], i["height"], i["mimeType"]) for i in case["images"]]
    codes = [
        code
        for code, _ in content_issues(
            case["platform"], case["text"], images, hashtag_count=case["hashtagCount"]
        )
    ]
    assert codes == case["blocking"]
