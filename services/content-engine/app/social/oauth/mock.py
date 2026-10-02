"""Offline connect flow (PUBLISH_MOCK=true, or provider 'mock').

The authorize URL points straight back at the CRM callback with a fixed code, so the
whole connect/disconnect UI can be exercised without a Meta or LinkedIn app.
"""

from __future__ import annotations

import datetime as dt
import urllib.parse
from typing import Any

from app.contracts import SocialProvider
from app.social.oauth.base import ConnectedAccount
from app.social.oauth.linkedin import author_kind_from

MOCK_CODE = "mock-code"


class MockOAuthProvider:
    def __init__(self, provider: SocialProvider) -> None:
        self._provider = provider

    def authorize_url(self, *, state: str, redirect_uri: str, options: dict[str, Any]) -> str:
        separator = "&" if "?" in redirect_uri else "?"
        return f"{redirect_uri}{separator}{urllib.parse.urlencode({'code': MOCK_CODE, 'state': state})}"

    async def exchange(
        self, code: str, *, redirect_uri: str, options: dict[str, Any]
    ) -> list[ConnectedAccount]:
        expires_at = (dt.datetime.now(dt.UTC) + dt.timedelta(days=60)).isoformat()
        if self._provider == "linkedin":
            kind = author_kind_from(options)
            return [
                ConnectedAccount(
                    platform="linkedin",
                    external_id="mock:member-1" if kind == "member" else "mock:org-1",
                    display_name="Mock LinkedIn member" if kind == "member" else "Mock LinkedIn Page",
                    author_kind=kind,  # type: ignore[arg-type]
                    access_token="mock-token-linkedin",
                    expires_at=expires_at,
                    scopes=("mock",),
                )
            ]
        return [
            ConnectedAccount(
                platform="facebook",
                external_id="mock:page-1",
                display_name="Mock Facebook Page",
                author_kind="page",
                access_token="mock-token-page",
                scopes=("mock",),
            ),
            ConnectedAccount(
                platform="instagram",
                external_id="mock:ig-1",
                display_name="@mock_instagram",
                author_kind="instagram_business",
                access_token="mock-token-page",
                scopes=("mock",),
            ),
        ]
