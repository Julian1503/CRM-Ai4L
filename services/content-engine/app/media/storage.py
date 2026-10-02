"""Storage I/O through signed URLs issued by the CRM. The engine holds no Storage key.

Download: a short-lived signed URL for the quarantine object, streamed with a byte cap.

Upload: Supabase Storage signed upload URLs (``createSignedUploadUrl``) are used the way
supabase-js ``uploadToSignedUrl`` uses them for a non-Blob body: ``PUT {signedUrl}``
(the URL already carries ``?token=…``) with the raw bytes as the body and headers
``content-type``, ``cache-control: max-age=…`` and ``x-upsert``. No Authorization
header is needed: the token authorises exactly one path. Signed URLs are never logged.
"""

from __future__ import annotations

from urllib.parse import urlsplit

import httpx

from app.contracts import SignedUpload
from app.redact import safe_url

CACHE_CONTROL_SECONDS = 3600


class StorageError(RuntimeError):
    def __init__(self, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.retryable = retryable


class SourceTooLarge(StorageError):
    def __init__(self, limit: int) -> None:
        super().__init__(f"The file is larger than {limit // (1024 * 1024)} MB.", retryable=False)


def _check_scheme(url: str, allow_http: bool) -> None:
    scheme = urlsplit(url).scheme
    if scheme == "https" or (allow_http and scheme == "http"):
        return
    raise StorageError(f"Refusing a non-https storage URL ({safe_url(url)}).", retryable=False)


class StorageClient:
    def __init__(
        self,
        *,
        allow_http: bool = False,
        timeout: float = 60.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._allow_http = allow_http
        self._timeout = timeout
        self._transport = transport

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=self._transport, timeout=self._timeout, follow_redirects=False)

    async def download(self, url: str, *, max_bytes: int) -> bytes:
        _check_scheme(url, self._allow_http)
        try:
            async with self._client() as client, client.stream("GET", url) as response:
                if response.status_code >= 500:
                    raise StorageError(
                        f"Storage download failed (HTTP {response.status_code}).", retryable=True
                    )
                if response.is_error:
                    raise StorageError(
                        f"Storage download refused (HTTP {response.status_code}).", retryable=False
                    )
                declared = response.headers.get("content-length")
                if declared and declared.isdigit() and int(declared) > max_bytes:
                    raise SourceTooLarge(max_bytes)
                chunks: list[bytes] = []
                total = 0
                async for chunk in response.aiter_bytes():
                    total += len(chunk)
                    if total > max_bytes:
                        raise SourceTooLarge(max_bytes)
                    chunks.append(chunk)
                return b"".join(chunks)
        except httpx.HTTPError as exc:
            raise StorageError(f"Storage download failed ({type(exc).__name__}).", retryable=True) from None

    async def upload(self, target: SignedUpload, data: bytes, mime_type: str) -> None:
        _check_scheme(target.signed_url, self._allow_http)
        headers = {
            "content-type": mime_type,
            "cache-control": f"max-age={CACHE_CONTROL_SECONDS}",
            # A retried job rewrites the same deterministic path.
            "x-upsert": "true",
        }
        try:
            async with self._client() as client:
                response = await client.put(target.signed_url, content=data, headers=headers)
        except httpx.HTTPError as exc:
            raise StorageError(f"Storage upload failed ({type(exc).__name__}).", retryable=True) from None
        if response.status_code >= 500:
            raise StorageError(
                f"Storage upload of {target.path} failed (HTTP {response.status_code}).", retryable=True
            )
        if response.is_error:
            raise StorageError(
                f"Storage refused the upload of {target.path} (HTTP {response.status_code}).", retryable=False
            )
