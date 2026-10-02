"""OAuth providers and the HMAC-authenticated engine API."""

from __future__ import annotations

import json
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from app import signing
from app.main import create_app
from app.social.oauth.base import OAuthError, validate_redirect_uri
from app.social.oauth.linkedin import LinkedInOAuthProvider
from app.social.oauth.meta import MetaOAuthProvider
from tests.conftest import TEST_ENGINE_SECRET, TEST_SECRET, make_settings

REDIRECT = "https://crm.test/api/social/oauth/meta/callback"
STATE = "state-0123456789abcdef"


def _live(**overrides):  # noqa: ANN202
    return make_settings(
        publish_mock=False,
        meta_app_id="app-id",
        meta_app_secret="app-secret-not-real",
        linkedin_client_id="li-id",
        linkedin_client_secret="li-secret-not-real",
        **overrides,
    )


async def _call(app, path: str, payload: dict, *, secret: str = TEST_ENGINE_SECRET) -> httpx.Response:  # noqa: ANN001
    body = json.dumps(payload).encode()
    headers = {"content-type": "application/json", **signing.signed_headers(secret, "POST", path, body)}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://engine") as client:
        return await client.post(path, content=body, headers=headers)


async def test_health_reports_modes_and_no_secrets() -> None:
    app = create_app(make_settings())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://engine") as client:
        response = await client.get("/health")
    assert response.json()["llmMock"] is True
    assert TEST_SECRET not in response.text


async def test_unsigned_or_wrongly_signed_requests_are_refused() -> None:
    app = create_app(make_settings())
    response = await _call(
        app, "/v1/oauth/mock/authorize-url", {"state": STATE, "redirectUri": REDIRECT}, secret="x" * 40
    )
    assert response.status_code == 401
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://engine") as client:
        assert (await client.post("/v1/oauth/mock/exchange", json={})).status_code == 401


async def test_mock_authorize_url_points_back_at_the_crm_callback() -> None:
    app = create_app(make_settings())
    response = await _call(app, "/v1/oauth/meta/authorize-url", {"state": STATE, "redirectUri": REDIRECT})
    url = response.json()["url"]
    assert url.startswith(REDIRECT)
    assert parse_qs(urlsplit(url).query)["state"] == [STATE]


async def test_mock_exchange_returns_accounts_in_the_contract_shape() -> None:
    app = create_app(make_settings())
    response = await _call(app, "/v1/oauth/meta/exchange", {"code": "mock-code", "redirectUri": REDIRECT})
    accounts = response.json()["accounts"]
    assert {a["platform"] for a in accounts} == {"facebook", "instagram"}
    assert {a["authorKind"] for a in accounts} == {"page", "instagram_business"}
    assert set(accounts[0]) >= {
        "platform",
        "externalId",
        "displayName",
        "authorKind",
        "scopes",
        "accessToken",
    }


async def test_unknown_provider_and_bad_redirect_are_refused() -> None:
    app = create_app(make_settings())
    assert (
        await _call(app, "/v1/oauth/x/authorize-url", {"state": STATE, "redirectUri": REDIRECT})
    ).status_code == 404
    bad = await _call(
        app, "/v1/oauth/meta/authorize-url", {"state": STATE, "redirectUri": "http://evil.test/cb"}
    )
    assert bad.status_code == 400


async def test_live_provider_without_credentials_is_503() -> None:
    app = create_app(make_settings(publish_mock=False))
    response = await _call(app, "/v1/oauth/linkedin/authorize-url", {"state": STATE, "redirectUri": REDIRECT})
    assert response.status_code == 503


def test_redirect_uri_rules() -> None:
    assert validate_redirect_uri("http://localhost:3000/cb", allow_local_http=True)
    with pytest.raises(OAuthError):
        validate_redirect_uri("http://localhost:3000/cb", allow_local_http=False)
    with pytest.raises(OAuthError):
        validate_redirect_uri("https://crm.test/cb#frag", allow_local_http=True)


def test_meta_authorize_url_uses_the_configured_version_and_scopes() -> None:
    url = MetaOAuthProvider(_live()).authorize_url(state=STATE, redirect_uri=REDIRECT, options={})
    assert url.startswith("https://www.facebook.com/v23.0/dialog/oauth?")
    assert "pages_manage_posts" in parse_qs(urlsplit(url).query)["scope"][0]
    with_config = MetaOAuthProvider(_live(meta_login_config_id="cfg")).authorize_url(
        state=STATE, redirect_uri=REDIRECT, options={}
    )
    assert "scope=" not in with_config and "config_id=cfg" in with_config


async def test_meta_exchange_discovers_pages_and_linked_instagram() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/oauth/access_token"):
            return httpx.Response(200, json={"access_token": "user-token"})
        if path.endswith("/me/accounts"):
            return httpx.Response(
                200, json={"data": [{"id": "p1", "name": "AI4L", "access_token": "page-token"}]}
            )
        return httpx.Response(200, json={"instagram_business_account": {"id": "ig1", "username": "ai4l"}})

    accounts = await MetaOAuthProvider(_live(), transport=httpx.MockTransport(handler)).exchange(
        "code", redirect_uri=REDIRECT, options={}
    )
    assert [(a.platform, a.author_kind, a.external_id) for a in accounts] == [
        ("facebook", "page", "p1"),
        ("instagram", "instagram_business", "ig1"),
    ]
    assert "page-token" not in repr(accounts)


async def test_meta_exchange_error_does_not_leak_the_app_secret() -> None:
    transport = httpx.MockTransport(
        lambda r: httpx.Response(
            400, json={"error": {"message": "Invalid client_secret=app-secret-not-real", "code": 100}}
        )
    )
    with pytest.raises(OAuthError) as caught:
        await MetaOAuthProvider(_live(), transport=transport).exchange("c", redirect_uri=REDIRECT, options={})
    assert "app-secret-not-real" not in str(caught.value)


def test_linkedin_scopes_follow_the_explicit_author_kind() -> None:
    provider = LinkedInOAuthProvider(_live())
    org = provider.authorize_url(state=STATE, redirect_uri=REDIRECT, options={})
    member = provider.authorize_url(state=STATE, redirect_uri=REDIRECT, options={"authorKind": "member"})
    assert "w_organization_social" in org and "w_member_social" not in org
    assert "w_member_social" in member
    with pytest.raises(OAuthError):
        provider.authorize_url(state=STATE, redirect_uri=REDIRECT, options={"authorKind": "page"})


async def test_linkedin_member_exchange_uses_the_userinfo_subject() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/accessToken"):
            return httpx.Response(200, json={"access_token": "tok", "expires_in": 3600})
        return httpx.Response(200, json={"sub": "person-9", "name": "Ana"})

    accounts = await LinkedInOAuthProvider(_live(), transport=httpx.MockTransport(handler)).exchange(
        "code", redirect_uri=REDIRECT, options={"authorKind": "member"}
    )
    assert accounts[0].external_id == "person-9" and accounts[0].author_kind == "member"
    assert accounts[0].expires_at is not None


async def test_linkedin_organization_exchange_without_pages_is_an_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/accessToken"):
            return httpx.Response(200, json={"access_token": "tok"})
        return httpx.Response(200, json={"elements": []})

    with pytest.raises(OAuthError):
        await LinkedInOAuthProvider(_live(), transport=httpx.MockTransport(handler)).exchange(
            "code", redirect_uri=REDIRECT, options={}
        )


async def test_the_worker_secret_does_not_authenticate_engine_calls() -> None:
    app = create_app(make_settings())
    response = await _call(
        app, "/v1/oauth/mock/authorize-url", {"state": STATE, "redirectUri": REDIRECT}, secret=TEST_SECRET
    )
    assert response.status_code == 401


async def test_an_oversized_body_is_refused_before_verification() -> None:
    app = create_app(make_settings())
    payload = {"state": STATE, "redirectUri": REDIRECT, "options": {"x": "a" * 300_000}}
    assert (await _call(app, "/v1/oauth/mock/authorize-url", payload)).status_code == 413


def test_the_api_refuses_to_start_without_its_own_secret() -> None:
    with pytest.raises(ValueError, match="CONTENT_ENGINE_SECRET"):
        create_app(make_settings(content_engine_secret=""))


def test_engine_and_worker_secrets_must_differ_and_production_needs_https() -> None:
    with pytest.raises(ValueError, match="must differ"):
        make_settings(content_engine_secret=TEST_SECRET)
    with pytest.raises(ValueError, match="CRM_BASE_URL"):
        make_settings(app_env="production", crm_base_url="http://crm.test")


async def test_mock_accounts_are_namespaced() -> None:
    app = create_app(make_settings())
    response = await _call(app, "/v1/oauth/linkedin/exchange", {"code": "mock-code", "redirectUri": REDIRECT})
    assert all(a["externalId"].startswith("mock:") for a in response.json()["accounts"])


def test_development_is_accepted_and_allows_local_http_redirects() -> None:
    settings = make_settings(app_env="development", crm_base_url="http://host.docker.internal:3000")
    assert settings.app_env == "development"
