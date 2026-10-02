"""Keep secrets out of logs and error messages.

Provider errors sometimes echo the request back, and httpx puts the full URL (query
string included) in its exception messages. Everything that is logged or reported to
the CRM goes through ``redact`` first, and URLs are logged by host + path only.
"""

from __future__ import annotations

import re
from urllib.parse import urlsplit

_SECRET_PARAMS = ("access_token", "client_secret", "fb_exchange_token", "code", "token", "refresh_token")
_PARAM_RE = re.compile(r"(?i)\b(" + "|".join(_SECRET_PARAMS) + r")=([^&\s\"']*)")
_BEARER_RE = re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+")
_JSON_SECRET_RE = re.compile(
    r'(?i)"(access_?token|refresh_?token|client_?secret|accessToken|refreshToken)"\s*:\s*"[^"]*"'
)

MAX_MESSAGE_CHARS = 900


def redact(text: object) -> str:
    """Blank out token-like values in free text."""
    value = str(text)
    value = _PARAM_RE.sub(lambda m: f"{m.group(1)}=REDACTED", value)
    value = _BEARER_RE.sub("Bearer REDACTED", value)
    value = _JSON_SECRET_RE.sub(lambda m: f'"{m.group(1)}":"REDACTED"', value)
    return value[:MAX_MESSAGE_CHARS]


def safe_url(url: str) -> str:
    """Scheme, host and path only — never a query string or fragment."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return "<invalid url>"
    host = parts.hostname or ""
    return f"{parts.scheme}://{host}{parts.path}"
