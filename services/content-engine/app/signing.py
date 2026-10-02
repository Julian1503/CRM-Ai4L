"""HMAC request signing shared with the CRM (src/lib/content-studio/workerAuth.ts).

Signature = "v1=" + hex(hmac_sha256(secret, f"{ts}.{METHOD}.{path}.{body}")), where
``path`` is the URL path (no query) and ``body`` the exact bytes sent. The same scheme
authenticates the CRM → engine OAuth calls (tolerance 300 s). The cross-language test
vector lives in shared/content-contracts/fixtures/worker-signature.json.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import time

TIMESTAMP_HEADER = "X-Content-Worker-Timestamp"
SIGNATURE_HEADER = "X-Content-Worker-Signature"
TOLERANCE_SECONDS = 300

_TIMESTAMP_RE = re.compile(r"^\d{1,12}$")
_SIGNATURE_RE = re.compile(r"^v1=[0-9a-f]{64}$")


def sign(secret: str, timestamp: int, method: str, path: str, body: bytes) -> str:
    prefix = f"{timestamp}.{method.upper()}.{path}.".encode()
    digest = hmac.new(secret.encode("utf-8"), prefix + body, hashlib.sha256).hexdigest()
    return f"v1={digest}"


def signed_headers(
    secret: str, method: str, path: str, body: bytes, *, now: int | None = None
) -> dict[str, str]:
    timestamp = int(time.time()) if now is None else now
    return {
        TIMESTAMP_HEADER: str(timestamp),
        SIGNATURE_HEADER: sign(secret, timestamp, method, path, body),
    }


def verify(
    secret: str,
    *,
    method: str,
    path: str,
    body: bytes,
    timestamp_header: str | None,
    signature_header: str | None,
    now: int | None = None,
) -> bool:
    """True only for a well-formed, in-tolerance signature over exactly these bytes."""
    if not secret or not timestamp_header or not signature_header:
        return False
    timestamp_text = timestamp_header.strip()
    signature = signature_header.strip()
    if not _TIMESTAMP_RE.match(timestamp_text) or not _SIGNATURE_RE.match(signature):
        return False
    timestamp = int(timestamp_text)
    current = int(time.time()) if now is None else now
    if abs(current - timestamp) > TOLERANCE_SECONDS:
        return False
    expected = sign(secret, timestamp, method, path, body)
    return hmac.compare_digest(expected, signature)
