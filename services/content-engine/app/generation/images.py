"""Image clients: deterministic mock (default) and OpenAI gpt-image-1.

Ported from WRCC ``llm/images.py``. Gemini image models are still not wired: with
LLM_PROVIDER=gemini and LLM_MOCK=false, image jobs fail with a clear ``config`` error.
"""

from __future__ import annotations

import base64
import hashlib
import struct
import zlib
from dataclasses import dataclass, field
from typing import Protocol

from app.config import Settings
from app.generation.llm import LLMError, with_retries

MOCK_IMAGE_SIZE = 1024  # Instagram rejects images under 320 px; keep the mock usable there.


@dataclass(frozen=True, slots=True)
class ImageResult:
    data: bytes
    request_id: str | None = None
    usage: dict[str, int] = field(default_factory=dict)


class ImageClient(Protocol):
    model_name: str

    async def generate_image(self, prompt: str, *, quality: str) -> ImageResult: ...


def solid_png(rgb: tuple[int, int, int], size: int = MOCK_IMAGE_SIZE) -> bytes:
    """A valid single-colour PNG without any imaging dependency."""

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    raw = b"".join(b"\x00" + bytes(rgb) * size for _ in range(size))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


class MockImageClient:
    model_name = "mock"

    async def generate_image(self, prompt: str, *, quality: str) -> ImageResult:
        digest = hashlib.sha256(prompt.encode("utf-8")).digest()
        return ImageResult(
            data=solid_png((digest[0], digest[1], digest[2])), request_id=f"mock-{digest.hex()[:16]}"
        )


class OpenAIImageClient:
    def __init__(self, settings: Settings) -> None:
        from openai import AsyncOpenAI

        self._client = AsyncOpenAI(
            api_key=settings.openai_api_key, timeout=settings.image_timeout_seconds, max_retries=0
        )
        self.model_name = settings.image_model
        self._size = settings.image_size

    async def generate_image(self, prompt: str, *, quality: str) -> ImageResult:
        async def attempt_once() -> ImageResult:
            response = await self._client.images.generate(  # type: ignore[call-overload]
                model=self.model_name,
                prompt=prompt,
                size=self._size,
                quality=quality,
                n=1,
            )
            payload = response.data[0].b64_json if response.data else None
            if not payload:
                raise LLMError("invalid", "The image provider returned an empty payload.")
            usage = getattr(response, "usage", None)
            return ImageResult(
                data=base64.b64decode(payload),
                request_id=getattr(response, "_request_id", None),
                usage={"totalTokens": int(getattr(usage, "total_tokens", 0) or 0)} if usage else {},
            )

        # One attempt: an image is slow and costly; the job-level retry decides the rest.
        return await with_retries("OpenAI image", attempt_once, attempts=1)


def get_image_client(settings: Settings) -> ImageClient:
    if settings.llm_mock:
        return MockImageClient()
    if settings.llm_provider == "openai":
        return OpenAIImageClient(settings)
    raise LLMError("config", "Image generation requires LLM_PROVIDER=openai (or LLM_MOCK=true).")
