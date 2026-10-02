"""LinkedIn connect flow. Ported from WRCC ``oauth/linkedin.py``.

The author kind is chosen explicitly by the CRM per connection
(``options.authorKind``: ``organization`` — the default — or ``member``). WRCC derived it
from a global LINKEDIN_AUTHOR_URN and could fall back to a personal profile; there is no
such fallback here (plan §9). Member mode reads the person id from OpenID ``/v2/userinfo``.
"""

from __future__ import annotations

import datetime as dt
import urllib.parse
from typing import Any

import httpx

from app.config import Settings
from app.social.oauth.base import ConnectedAccount, OAuthError, OAuthNotConfigured

AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization"
TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken"
API_BASE = "https://api.linkedin.com"

ORGANIZATION_SCOPES = ("w_organization_social", "r_organization_social", "rw_organization_admin")
MEMBER_SCOPES = ("w_member_social", "openid", "profile")


def author_kind_from(options: dict[str, Any]) -> str:
    kind = str(options.get("authorKind") or "organization")
    if kind not in ("organization", "member"):
        raise OAuthError("LinkedIn authorKind must be 'organization' or 'member'.")
    return kind


class LinkedInOAuthProvider:
    def __init__(self, settings: Settings, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        if not settings.linkedin_client_id or not settings.linkedin_client_secret:
            raise OAuthNotConfigured(
                "LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET are not configured on the engine."
            )
        self._settings = settings
        self._transport = transport

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=self._transport, timeout=self._settings.publish_timeout_seconds)

    def _headers(self, token: str) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {token}",
            "LinkedIn-Version": self._settings.linkedin_api_version,
            "X-Restli-Protocol-Version": "2.0.0",
        }

    def authorize_url(self, *, state: str, redirect_uri: str, options: dict[str, Any]) -> str:
        scopes = MEMBER_SCOPES if author_kind_from(options) == "member" else ORGANIZATION_SCOPES
        params = {
            "response_type": "code",
            "client_id": self._settings.linkedin_client_id,
            "redirect_uri": redirect_uri,
            "state": state,
            "scope": " ".join(scopes),
        }
        return f"{AUTHORIZE_URL}?{urllib.parse.urlencode(params)}"

    async def exchange(
        self, code: str, *, redirect_uri: str, options: dict[str, Any]
    ) -> list[ConnectedAccount]:
        kind = author_kind_from(options)
        token, expires_at, refresh = await self._token(code, redirect_uri)
        if kind == "member":
            return [await self._member_account(token, expires_at, refresh)]
        return await self._organization_accounts(token, expires_at, refresh)

    async def _token(self, code: str, redirect_uri: str) -> tuple[str, str | None, str | None]:
        try:
            async with self._client() as client:
                response = await client.post(
                    TOKEN_URL,
                    data={
                        "grant_type": "authorization_code",
                        "code": code,
                        "client_id": self._settings.linkedin_client_id,
                        "client_secret": self._settings.linkedin_client_secret,
                        "redirect_uri": redirect_uri,
                    },
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                )
        except httpx.HTTPError as exc:
            raise OAuthError(f"LinkedIn token exchange failed ({type(exc).__name__}).") from None
        payload = self._json(response, "token exchange")
        token = payload.get("access_token")
        if not token:
            raise OAuthError(str(payload.get("error_description") or "LinkedIn refused the sign-in."))
        expires_in = payload.get("expires_in")
        expires_at = (
            (dt.datetime.now(dt.UTC) + dt.timedelta(seconds=int(expires_in))).isoformat()
            if expires_in
            else None
        )
        return str(token), expires_at, payload.get("refresh_token")

    async def _organization_accounts(
        self, token: str, expires_at: str | None, refresh: str | None
    ) -> list[ConnectedAccount]:
        async with self._client() as client:
            response = await client.get(
                f"{API_BASE}/rest/organizationAcls",
                params={
                    "q": "roleAssignee",
                    "role": "ADMINISTRATOR",
                    "state": "APPROVED",
                    "projection": "(elements*(organization~(localizedName)))",
                },
                headers=self._headers(token),
            )
        payload = self._json(response, "organization lookup")
        accounts: list[ConnectedAccount] = []
        for element in payload.get("elements") or []:
            urn = str(element.get("organization", ""))
            if not urn:
                continue
            decorated = element.get("organization~") or {}
            accounts.append(
                ConnectedAccount(
                    platform="linkedin",
                    external_id=urn.rsplit(":", 1)[-1],
                    display_name=str(decorated.get("localizedName") or urn),
                    author_kind="organization",
                    access_token=token,
                    refresh_token=refresh,
                    expires_at=expires_at,
                    scopes=ORGANIZATION_SCOPES,
                )
            )
        if not accounts:
            raise OAuthError(
                "That LinkedIn account does not administer any Company Page, or the Community "
                "Management API product is not approved for this app."
            )
        return accounts

    async def _member_account(
        self, token: str, expires_at: str | None, refresh: str | None
    ) -> ConnectedAccount:
        async with self._client() as client:
            response = await client.get(f"{API_BASE}/v2/userinfo", headers=self._headers(token))
        payload = self._json(response, "profile lookup")
        person_id = str(payload.get("sub") or "")
        if not person_id:
            raise OAuthError("LinkedIn did not return the member id.")
        return ConnectedAccount(
            platform="linkedin",
            external_id=person_id,
            display_name=str(payload.get("name") or "LinkedIn member"),
            author_kind="member",
            access_token=token,
            refresh_token=refresh,
            expires_at=expires_at,
            scopes=MEMBER_SCOPES,
        )

    def _json(self, response: httpx.Response, stage: str) -> dict:
        try:
            payload = response.json()
        except ValueError:
            raise OAuthError(f"LinkedIn returned an unreadable response during the {stage}.") from None
        if not isinstance(payload, dict):
            raise OAuthError(f"LinkedIn returned an unexpected {stage} response.")
        if response.is_error:
            message = payload.get("error_description") or payload.get("message")
            raise OAuthError(str(message or f"LinkedIn rejected the {stage} (HTTP {response.status_code})."))
        return payload
