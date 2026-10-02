"""Meta (Facebook Page + Instagram Business) connect flow. Ported from WRCC ``oauth/meta.py``.

Code → short-lived user token → long-lived user token → Pages (``/me/accounts``, then the
Business Portfolio fallback) → each Page's linked Instagram Business account. Page tokens
minted from a long-lived user token carry no expiry. Graph version from META_GRAPH_VERSION
(default v23.0) — revalidate before going live.
"""

from __future__ import annotations

import urllib.parse
from typing import Any

import httpx

from app.config import Settings
from app.social.meta_graph import GraphClient, MetaGraphError
from app.social.oauth.base import ConnectedAccount, OAuthError, OAuthNotConfigured

SCOPES = (
    "pages_show_list",
    "pages_read_engagement",
    "pages_manage_posts",
    "business_management",
    "instagram_basic",
    "instagram_content_publish",
)


class MetaOAuthProvider:
    def __init__(self, settings: Settings, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        if not settings.meta_app_id or not settings.meta_app_secret:
            raise OAuthNotConfigured("META_APP_ID and META_APP_SECRET are not configured on the engine.")
        self._settings = settings
        self._transport = transport

    def _graph(self, token: str | None = None) -> GraphClient:
        return GraphClient(
            self._settings.graph_base_url,
            timeout=self._settings.publish_timeout_seconds,
            access_token=token,
            transport=self._transport,
        )

    def authorize_url(self, *, state: str, redirect_uri: str, options: dict[str, Any]) -> str:
        """With a Login for Business ``config_id`` the scope must be omitted (else "Invalid Scopes")."""
        params = {
            "client_id": self._settings.meta_app_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "state": state,
        }
        if self._settings.meta_login_config_id:
            params["config_id"] = self._settings.meta_login_config_id
        else:
            params["scope"] = ",".join(SCOPES)
        version = self._settings.meta_graph_version
        return f"https://www.facebook.com/{version}/dialog/oauth?{urllib.parse.urlencode(params)}"

    async def exchange(
        self, code: str, *, redirect_uri: str, options: dict[str, Any]
    ) -> list[ConnectedAccount]:
        client = self._graph()
        try:
            short_lived = await self._token(client, {"redirect_uri": redirect_uri, "code": code})
            long_lived = await self._token(
                client, {"grant_type": "fb_exchange_token", "fb_exchange_token": short_lived}
            )
            return await self._discover(long_lived)
        except MetaGraphError as exc:
            raise OAuthError(str(exc)) from None

    async def _token(self, client: GraphClient, params: dict[str, str]) -> str:
        payload = await client.get(
            "/oauth/access_token",
            params={
                "client_id": self._settings.meta_app_id,
                "client_secret": self._settings.meta_app_secret,
                **params,
            },
        )
        token = payload.get("access_token")
        if not token:
            raise OAuthError("Meta did not return an access token.")
        return str(token)

    async def _discover(self, user_token: str) -> list[ConnectedAccount]:
        client = self._graph(user_token)
        payload = await client.get("/me/accounts", params={"fields": "id,name,access_token"})
        pages = list(payload.get("data") or []) or await self._pages_via_businesses(client)
        if not pages:
            raise OAuthError(await self._explain_no_pages(client))
        accounts: list[ConnectedAccount] = []
        for page in pages:
            page_id, page_token = str(page.get("id", "")), str(page.get("access_token", ""))
            if not page_id or not page_token:
                continue
            accounts.append(
                ConnectedAccount(
                    platform="facebook",
                    external_id=page_id,
                    display_name=str(page.get("name") or f"Page {page_id}"),
                    author_kind="page",
                    access_token=page_token,
                    scopes=SCOPES,
                )
            )
            instagram = await self._instagram_for_page(page_id, page_token)
            if instagram is not None:
                accounts.append(instagram)
        if not accounts:
            raise OAuthError("Meta returned Pages without usable access tokens.")
        return accounts

    async def _pages_via_businesses(self, client: GraphClient) -> list[dict]:
        """Pages owned by (or shared with) the user's Business Portfolios. Best-effort."""
        try:
            payload = await client.get("/me/businesses", params={"fields": "id,name"})
        except MetaGraphError:
            return []
        seen: dict[str, dict] = {}
        for business in payload.get("data") or []:
            business_id = str(business.get("id") or "")
            for edge in ("owned_pages", "client_pages") if business_id else ():
                try:
                    found = await client.get(
                        f"/{business_id}/{edge}", params={"fields": "id,name,access_token"}
                    )
                except MetaGraphError:
                    continue
                for page in found.get("data") or []:
                    if page.get("id"):
                        seen.setdefault(str(page["id"]), page)
        resolved: list[dict] = []
        for page_id, page in seen.items():
            if page.get("access_token"):
                resolved.append(page)
                continue
            try:
                detail = await client.get(f"/{page_id}", params={"fields": "name,access_token"})
            except MetaGraphError:
                continue
            if detail.get("access_token"):
                resolved.append(
                    {
                        "id": page_id,
                        "name": page.get("name") or detail.get("name"),
                        "access_token": detail["access_token"],
                    }
                )
        return resolved

    async def _explain_no_pages(self, client: GraphClient) -> str:
        granted: list[str] = []
        try:
            perms = await client.get("/me/permissions")
            granted = sorted(
                str(row.get("permission"))
                for row in (perms.get("data") or [])
                if row.get("status") == "granted"
            )
        except MetaGraphError:
            pass
        parts = [
            "Meta authorised the app but returned no Pages.",
            f"Permissions granted: {', '.join(granted) if granted else 'none'}.",
        ]
        if "pages_show_list" not in granted:
            parts.append("`pages_show_list` is missing from the Login for Business configuration.")
        elif "business_management" not in granted:
            parts.append(
                "`business_management` is missing; Pages owned by a Business Portfolio "
                "are invisible without it."
            )
        else:
            parts.append(
                "Permissions look complete: reconnect and tick the Page on the asset-selection step."
            )
        return " ".join(parts)

    async def _instagram_for_page(self, page_id: str, page_token: str) -> ConnectedAccount | None:
        try:
            payload = await self._graph(page_token).get(
                f"/{page_id}", params={"fields": "instagram_business_account{id,username}"}
            )
        except MetaGraphError:
            return None
        linked = payload.get("instagram_business_account") or {}
        ig_id = str(linked.get("id", ""))
        if not ig_id:
            return None
        username = linked.get("username")
        return ConnectedAccount(
            platform="instagram",
            external_id=ig_id,
            display_name=f"@{username}" if username else f"Instagram {ig_id}",
            author_kind="instagram_business",
            # Instagram publishing authenticates with the parent Page's token.
            access_token=page_token,
            scopes=SCOPES,
        )
