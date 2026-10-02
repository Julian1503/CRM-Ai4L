"""The OAuth seam for the Meta and LinkedIn connect flows. Ported from WRCC ``oauth/base.py``.

Changes: the redirect URI is supplied per call by the CRM (its callback route), state is
created and checked by the CRM (single use), and the author kind of every discovered
destination is explicit. The engine only builds the consent URL and exchanges the code;
the tokens it returns go straight back to the CRM server, which encrypts them.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol
from urllib.parse import urlsplit

from app.contracts import SocialAuthorKind, SocialPlatform


class OAuthError(RuntimeError):
    """A connect flow failed. Carries only the provider's description, never a secret."""


class OAuthNotConfigured(OAuthError):
    """The engine has no app credentials for this provider."""


@dataclass(frozen=True, slots=True)
class ConnectedAccount:
    platform: SocialPlatform
    external_id: str
    display_name: str
    author_kind: SocialAuthorKind
    access_token: str = field(repr=False)
    refresh_token: str | None = field(default=None, repr=False)
    expires_at: str | None = None  # ISO-8601 UTC
    scopes: tuple[str, ...] = ()

    def to_wire(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "platform": self.platform,
            "externalId": self.external_id,
            "displayName": self.display_name,
            "authorKind": self.author_kind,
            "scopes": list(self.scopes),
            "accessToken": self.access_token,
        }
        if self.refresh_token:
            data["refreshToken"] = self.refresh_token
        if self.expires_at:
            data["expiresAt"] = self.expires_at
        return data


class OAuthProvider(Protocol):
    def authorize_url(self, *, state: str, redirect_uri: str, options: dict[str, Any]) -> str: ...

    async def exchange(
        self, code: str, *, redirect_uri: str, options: dict[str, Any]
    ) -> list[ConnectedAccount]: ...


_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


def validate_redirect_uri(redirect_uri: str, *, allow_local_http: bool) -> str:
    """https only (plain http for localhost outside production); no fragment or userinfo."""
    parts = urlsplit(redirect_uri)
    if parts.fragment or parts.username or parts.password or not parts.hostname:
        raise OAuthError("The redirect URI is not valid.")
    if parts.scheme == "https":
        return redirect_uri
    if parts.scheme == "http" and allow_local_http and parts.hostname in _LOCAL_HOSTS:
        return redirect_uri
    raise OAuthError("The redirect URI must use https.")
