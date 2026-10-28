"""Offline connect flow (PUBLISH_MOCK=true, or provider 'mock').

The authorize URL points straight back at the CRM callback with a fixed code, so the
whole connect/disconnect UI can be exercised without a Meta app.
"""

from __future__ import annotations

import urllib.parse

from app.social.oauth.base import ConnectedAccount

MOCK_CODE = "mock-code"


class MockOAuthProvider:
    def authorize_url(self, *, state: str, redirect_uri: str) -> str:
        separator = "&" if "?" in redirect_uri else "?"
        return f"{redirect_uri}{separator}{urllib.parse.urlencode({'code': MOCK_CODE, 'state': state})}"

    async def exchange(self, code: str, *, redirect_uri: str) -> list[ConnectedAccount]:
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
