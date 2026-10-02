"""Reference-URL fetch behind SSRF limits (plan §10).

WRCC fetched the URL with ``follow_redirects=True`` and read the whole body before
trimming it. This version:

* accepts only ``https`` on the default port, without userinfo;
* resolves the host and refuses the fetch unless **every** address is public (no
  private, loopback, link-local/metadata, CGNAT, multicast, reserved or unspecified);
* connects to the validated IP itself (Host header + TLS SNI keep the name), so a DNS
  answer that changes between check and connect cannot redirect the request;
* follows at most N redirects by hand, re-validating each hop;
* streams the body with a byte cap and checks the content type;
* bounds the whole fetch with one deadline.

A failure never blocks generation: it becomes a warning. The excerpt is untrusted data
and is wrapped as such in the prompt (app.generation.prompts).
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import socket
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx
from bs4 import BeautifulSoup

from app.redact import safe_url

logger = logging.getLogger(__name__)

Resolver = Callable[[str, int], Awaitable[list[str]]]

_ALLOWED_TYPES = ("text/html", "text/plain", "application/xhtml+xml")
_REDIRECTS = {301, 302, 303, 307, 308}


class ReferenceBlocked(ValueError):
    """The URL (or a redirect hop) is not something we are willing to fetch."""


@dataclass(frozen=True, slots=True)
class FetchLimits:
    timeout_seconds: float
    max_bytes: int
    max_chars: int
    max_redirects: int
    user_agent: str


async def system_resolver(host: str, port: int) -> list[str]:
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return sorted({str(info[4][0]) for info in infos})


def is_public_address(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    if (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    ):
        return False
    return ip.is_global


def validate_url(url: str) -> tuple[str, str]:
    """Return (host, url) for an acceptable https URL, else raise ReferenceBlocked."""
    try:
        parts = urlsplit(url.strip())
    except ValueError as exc:
        raise ReferenceBlocked("not a valid URL") from exc
    if parts.scheme != "https":
        raise ReferenceBlocked("only https reference URLs are fetched")
    if parts.username or parts.password:
        raise ReferenceBlocked("URLs with credentials are not fetched")
    if not parts.hostname:
        raise ReferenceBlocked("URL has no host")
    try:
        port = parts.port
    except ValueError as exc:
        raise ReferenceBlocked("the URL has an invalid port") from exc
    if port not in (None, 443):
        raise ReferenceBlocked("only the default https port is fetched")
    clean = urlunsplit((parts.scheme, parts.netloc, parts.path or "/", parts.query, ""))
    return parts.hostname, clean


async def resolve_public(host: str, resolver: Resolver) -> str:
    """The first address of ``host``, provided every address it resolves to is public."""
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    addresses = [str(literal)] if literal is not None else await resolver(host, 443)
    if not addresses:
        raise ReferenceBlocked("host did not resolve")
    blocked = [address for address in addresses if not is_public_address(address)]
    if blocked:
        raise ReferenceBlocked("host resolves to a non-public address")
    return addresses[0]


def _pinned_url(url: str, address: str) -> str:
    parts = urlsplit(url)
    host = f"[{address}]" if ":" in address else address
    return urlunsplit((parts.scheme, host, parts.path or "/", parts.query, ""))


async def _read_capped(response: httpx.Response, max_bytes: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    async for chunk in response.aiter_bytes():
        remaining = max_bytes - total
        if remaining <= 0:
            break
        chunks.append(chunk[:remaining])
        total += min(len(chunk), remaining)
    return b"".join(chunks)


def extract_text(html: bytes, encoding: str | None, max_chars: int) -> str:
    text = html.decode(encoding or "utf-8", errors="replace")
    soup = BeautifulSoup(text, "html.parser")
    for tag in soup(["script", "style", "nav", "footer", "header", "noscript", "template"]):
        tag.decompose()
    return " ".join(soup.get_text(" ", strip=True).split())[:max_chars]


async def _fetch(
    url: str, limits: FetchLimits, resolver: Resolver, transport: httpx.AsyncBaseTransport | None
) -> str:
    current = url
    async with httpx.AsyncClient(
        transport=transport, follow_redirects=False, timeout=limits.timeout_seconds
    ) as client:
        for _hop in range(limits.max_redirects + 1):
            host, current = validate_url(current)
            address = await resolve_public(host, resolver)
            request = client.build_request(
                "GET",
                _pinned_url(current, address),
                headers={"Host": host, "User-Agent": limits.user_agent, "Accept": "text/html,text/plain"},
                extensions={"sni_hostname": host},
            )
            response = await client.send(request, stream=True)
            try:
                if response.status_code in _REDIRECTS:
                    location = response.headers.get("location")
                    if not location:
                        raise ReferenceBlocked("redirect without a location")
                    current = urljoin(current, location)
                    continue
                if response.status_code != 200:
                    raise ReferenceBlocked(f"HTTP {response.status_code}")
                content_type = response.headers.get("content-type", "").split(";")[0].strip().lower()
                if content_type not in _ALLOWED_TYPES:
                    raise ReferenceBlocked(f"unsupported content type {content_type or 'unknown'}")
                body = await _read_capped(response, limits.max_bytes)
                return extract_text(body, response.encoding, limits.max_chars)
            finally:
                await response.aclose()
    raise ReferenceBlocked("too many redirects")


async def fetch_reference_excerpt(
    url: str,
    limits: FetchLimits,
    *,
    resolver: Resolver = system_resolver,
    transport: httpx.AsyncBaseTransport | None = None,
) -> tuple[str | None, str | None]:
    """Best-effort excerpt → (text, warning). Never raises."""
    try:
        async with asyncio.timeout(limits.timeout_seconds):
            text = await _fetch(url, limits, resolver, transport)
    except ReferenceBlocked as exc:
        return None, f"reference URL was not fetched ({exc})"
    except (TimeoutError, httpx.HTTPError, OSError, UnicodeError) as exc:
        logger.warning("Reference fetch failed for %s: %s", safe_url(url), type(exc).__name__)
        return None, "reference URL could not be fetched"
    except ValueError:
        return None, "reference URL was not fetched (not a valid URL)"
    if not text:
        return None, "reference URL yielded no text"
    return text, None
