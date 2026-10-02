"""HMAC signing: the cross-language vector, verification rules and the CRM client."""

from __future__ import annotations

import json

import httpx
import pytest

from app import signing
from app.crm_client import CrmClient, CrmError, encode_body
from tests.conftest import TEST_SECRET, load_fixture

VECTOR = load_fixture("worker-signature.json")


def test_python_signature_matches_the_shared_vector() -> None:
    assert (
        signing.sign(
            VECTOR["secret"],
            VECTOR["timestamp"],
            VECTOR["method"],
            VECTOR["path"],
            VECTOR["body"].encode("utf-8"),
        )
        == VECTOR["signature"]
    )


def _verify(**overrides) -> bool:
    args = {
        "method": VECTOR["method"],
        "path": VECTOR["path"],
        "body": VECTOR["body"].encode(),
        "timestamp_header": str(VECTOR["timestamp"]),
        "signature_header": VECTOR["signature"],
        "now": VECTOR["timestamp"],
    }
    args.update(overrides)
    return signing.verify(VECTOR["secret"], **args)


def test_verify_accepts_the_vector() -> None:
    assert _verify()


@pytest.mark.parametrize(
    "overrides",
    [
        {"body": b'{"limit":20}'},
        {"path": "/api/internal/content-worker/v1/complete"},
        {"method": "PUT"},
        {"now": VECTOR["timestamp"] + 301},
        {"now": VECTOR["timestamp"] - 301},
        {"signature_header": "v1=zz"},
        {"timestamp_header": "abc"},
        {"signature_header": None},
    ],
)
def test_verify_refuses_tampering_and_staleness(overrides) -> None:
    assert not _verify(**overrides)


def test_verify_fails_closed_without_a_secret() -> None:
    assert not signing.verify(
        "",
        method="POST",
        path="/x",
        body=b"",
        timestamp_header="1",
        signature_header="v1=" + "0" * 64,
        now=1,
    )


async def test_crm_client_signs_the_exact_bytes_it_sends() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"jobs": []})

    client = CrmClient("https://crm.test", TEST_SECRET, transport=httpx.MockTransport(handler))
    assert await client.claim("worker-1", ["ingest_asset"], 1, 120) == []
    await client.aclose()

    request = seen[0]
    assert request.url.path == "/api/internal/content-worker/v1/claim"
    assert request.content == encode_body(
        {"workerId": "worker-1", "kinds": ["ingest_asset"], "limit": 1, "leaseSeconds": 120}
    )
    assert signing.verify(
        TEST_SECRET,
        method="POST",
        path=request.url.path,
        body=request.content,
        timestamp_header=request.headers[signing.TIMESTAMP_HEADER],
        signature_header=request.headers[signing.SIGNATURE_HEADER],
    )


async def test_crm_client_signs_the_base_path_too() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"state": "ok"})

    client = CrmClient("https://crm.test/prefix/", TEST_SECRET, transport=httpx.MockTransport(handler))
    await client.heartbeat("job", "token")
    await client.aclose()
    assert seen[0].url.path == "/prefix/api/internal/content-worker/v1/heartbeat"
    assert signing.verify(
        TEST_SECRET,
        method="POST",
        path=seen[0].url.path,
        body=seen[0].content,
        timestamp_header=seen[0].headers[signing.TIMESTAMP_HEADER],
        signature_header=seen[0].headers[signing.SIGNATURE_HEADER],
    )


@pytest.mark.parametrize(("status", "retryable"), [(500, True), (503, True), (401, False), (409, False)])
async def test_crm_errors_are_classified(status: int, retryable: bool) -> None:
    transport = httpx.MockTransport(lambda _r: httpx.Response(status, json={"error": "nope"}))
    client = CrmClient("https://crm.test", TEST_SECRET, transport=transport)
    with pytest.raises(CrmError) as caught:
        await client.checkpoint("job", "token", {"a": 1})
    await client.aclose()
    assert caught.value.retryable is retryable


async def test_fail_payload_matches_the_contract() -> None:
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return httpx.Response(200, json={"accepted": True})

    client = CrmClient("https://crm.test", TEST_SECRET, transport=httpx.MockTransport(handler))
    assert await client.fail(
        "job", "tok", outcome="uncertain", error_code="x", message="m", provider_request_id="r"
    )
    await client.aclose()
    assert seen[0] == {
        "jobId": "job",
        "claimToken": "tok",
        "outcome": "uncertain",
        "errorCode": "x",
        "message": "m",
        "providerRequestId": "r",
    }
