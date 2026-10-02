"""SSRF guard for reference URLs: scheme, DNS, private ranges, redirects, size, type."""

from __future__ import annotations

import httpx
import pytest

from app.generation.reference import FetchLimits, fetch_reference_excerpt, is_public_address

LIMITS = FetchLimits(timeout_seconds=2, max_bytes=2000, max_chars=500, max_redirects=3, user_agent="test")
PUBLIC_IP = "93.184.216.34"


def resolver_for(mapping: dict[str, list[str]]):  # noqa: ANN201
    async def resolve(host: str, port: int) -> list[str]:
        return mapping.get(host, [])

    return resolve


def html(body: str) -> httpx.Response:
    return httpx.Response(200, headers={"content-type": "text/html; charset=utf-8"}, content=body.encode())


@pytest.mark.parametrize(
    "address",
    [
        "127.0.0.1",
        "10.0.0.5",
        "172.16.1.1",
        "192.168.1.1",
        "169.254.169.254",
        "100.64.0.1",
        "0.0.0.0",
        "224.0.0.1",
        "::1",
        "fe80::1",
        "fd00::1",
        "::ffff:127.0.0.1",
        "240.0.0.1",
    ],
)
def test_non_public_addresses_are_refused(address: str) -> None:
    assert not is_public_address(address)


def test_public_addresses_are_allowed() -> None:
    assert is_public_address(PUBLIC_IP)
    assert is_public_address("2606:4700:4700::1111")


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com/",
        "ftp://example.com/",
        "https://user:pw@example.com/",
        "https://example.com:8443/",
        "https://127.0.0.1/",
        "https://[::1]/",
    ],
)
async def test_bad_urls_are_not_fetched(url: str) -> None:
    calls: list[httpx.Request] = []
    transport = httpx.MockTransport(lambda r: calls.append(r) or html("x"))
    text, warning = await fetch_reference_excerpt(url, LIMITS, resolver=resolver_for({}), transport=transport)
    assert text is None and warning
    assert calls == []


async def test_a_host_resolving_to_a_private_address_is_refused() -> None:
    resolver = resolver_for({"internal.example": [PUBLIC_IP, "10.0.0.1"]})
    text, warning = await fetch_reference_excerpt(
        "https://internal.example/",
        LIMITS,
        resolver=resolver,
        transport=httpx.MockTransport(lambda r: html("x")),
    )
    assert text is None and "non-public" in (warning or "")


async def test_the_connection_is_pinned_to_the_validated_ip_with_host_and_sni() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return html("<html><script>x()</script><p>Hello   world</p></html>")

    text, warning = await fetch_reference_excerpt(
        "https://site.example/page?q=1",
        LIMITS,
        resolver=resolver_for({"site.example": [PUBLIC_IP]}),
        transport=httpx.MockTransport(handler),
    )
    assert (text, warning) == ("Hello world", None)
    assert seen[0].url.host == PUBLIC_IP
    assert seen[0].headers["host"] == "site.example"
    assert seen[0].extensions["sni_hostname"] == "site.example"


async def test_every_redirect_hop_is_revalidated() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "https://metadata.example/latest"})

    resolver = resolver_for({"site.example": [PUBLIC_IP], "metadata.example": ["169.254.169.254"]})
    text, warning = await fetch_reference_excerpt(
        "https://site.example/", LIMITS, resolver=resolver, transport=httpx.MockTransport(handler)
    )
    assert text is None and "non-public" in (warning or "")


async def test_redirects_are_capped() -> None:
    transport = httpx.MockTransport(lambda r: httpx.Response(301, headers={"location": "/again"}))
    text, warning = await fetch_reference_excerpt(
        "https://site.example/",
        LIMITS,
        resolver=resolver_for({"site.example": [PUBLIC_IP]}),
        transport=transport,
    )
    assert text is None and "too many redirects" in (warning or "")


async def test_non_text_content_is_refused() -> None:
    transport = httpx.MockTransport(
        lambda r: httpx.Response(200, headers={"content-type": "application/pdf"}, content=b"%PDF")
    )
    text, warning = await fetch_reference_excerpt(
        "https://site.example/",
        LIMITS,
        resolver=resolver_for({"site.example": [PUBLIC_IP]}),
        transport=transport,
    )
    assert text is None and "content type" in (warning or "")


async def test_the_body_is_capped_while_streaming() -> None:
    transport = httpx.MockTransport(lambda r: html("<p>" + "a" * 100_000 + "</p>"))
    text, _warning = await fetch_reference_excerpt(
        "https://site.example/",
        LIMITS,
        resolver=resolver_for({"site.example": [PUBLIC_IP]}),
        transport=transport,
    )
    assert text is not None and len(text) <= LIMITS.max_chars


async def test_an_invalid_port_is_a_warning_not_a_crash() -> None:
    text, warning = await fetch_reference_excerpt(
        "https://site.example:99999/",
        LIMITS,
        resolver=resolver_for({}),
        transport=httpx.MockTransport(lambda r: html("x")),
    )
    assert text is None and "invalid port" in (warning or "")
