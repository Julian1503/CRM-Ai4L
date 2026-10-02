"""Renditions and publish-time formats.

``to_jpeg`` is ported from WRCC ``publishing/media.py`` (flatten alpha onto white, cap the
width, JPEG q88). The signed-URL half of that module is not ported: published images are
served from the CRM's immutable ``content-public`` Storage paths instead.
"""

from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass

from PIL import Image, UnidentifiedImageError

JPEG_QUALITY = 88
SOCIAL_MAX_WIDTH = 1440  # Instagram's largest rendered width; also fine for FB/LinkedIn.
EMAIL_MAX_WIDTH = 1200
INSTAGRAM_MIN_WIDTH = 320
INSTAGRAM_MIN_ASPECT = 0.8  # 4:5 portrait
INSTAGRAM_MAX_ASPECT = 1.91  # 1.91:1 landscape

MIME_JPEG = "image/jpeg"
MIME_PNG = "image/png"


class MediaConversionError(RuntimeError):
    """Stored bytes could not be decoded."""


@dataclass(frozen=True, slots=True)
class EncodedImage:
    data: bytes
    mime_type: str
    width: int
    height: int

    @property
    def checksum(self) -> str:
        return hashlib.sha256(self.data).hexdigest()

    @property
    def byte_size(self) -> int:
        return len(self.data)

    @property
    def extension(self) -> str:
        return "png" if self.mime_type == MIME_PNG else "jpg"


def _open(data: bytes) -> Image.Image:
    try:
        return Image.open(io.BytesIO(data))
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise MediaConversionError("Stored image data is not a readable image.") from exc


def _has_alpha(image: Image.Image) -> bool:
    return image.mode in ("RGBA", "LA", "PA") or (image.mode == "P" and "transparency" in image.info)


def _flatten(image: Image.Image) -> Image.Image:
    if image.mode in ("RGBA", "LA", "P", "PA"):
        rgba = image.convert("RGBA")
        flattened = Image.new("RGB", rgba.size, (255, 255, 255))
        flattened.paste(rgba, mask=rgba.split()[-1])
        return flattened
    return image.convert("RGB")


def _fit_width(image: Image.Image, max_width: int | None) -> Image.Image:
    if max_width is None or image.width <= max_width:
        return image
    height = max(1, round(image.height * max_width / image.width))
    return image.resize((max_width, height), Image.Resampling.LANCZOS)


def _encode(image: Image.Image, mime_type: str, quality: int) -> EncodedImage:
    buffer = io.BytesIO()
    if mime_type == MIME_PNG:
        image.save(buffer, format="PNG", optimize=True)
    else:
        image.save(buffer, format="JPEG", quality=quality, optimize=True)
    return EncodedImage(buffer.getvalue(), mime_type, image.width, image.height)


def to_jpeg(
    data: bytes, *, quality: int = JPEG_QUALITY, max_width: int | None = SOCIAL_MAX_WIDTH
) -> EncodedImage:
    """JPEG within the networks' limits; transparency flattened onto white, not black."""
    with _open(data) as image:
        return _encode(_fit_width(_flatten(image), max_width), MIME_JPEG, quality)


def email_rendition(data: bytes, *, max_width: int = EMAIL_MAX_WIDTH) -> EncodedImage:
    """PNG when the image has transparency (logos), JPEG otherwise; width-capped."""
    with _open(data) as image:
        if _has_alpha(image):
            return _encode(_fit_width(image.convert("RGBA"), max_width), MIME_PNG, JPEG_QUALITY)
        return _encode(_fit_width(image.convert("RGB"), max_width), MIME_JPEG, JPEG_QUALITY)


def instagram_problems(width: int, height: int) -> list[str]:
    """Spec violations we cannot fix for the operator (after downscaling to 1440 wide)."""
    problems: list[str] = []
    if min(width, SOCIAL_MAX_WIDTH) < INSTAGRAM_MIN_WIDTH:
        problems.append(f"The image is {width}px wide; Instagram needs at least {INSTAGRAM_MIN_WIDTH}px.")
    if height <= 0:
        return problems
    aspect = width / height
    if aspect < INSTAGRAM_MIN_ASPECT or aspect > INSTAGRAM_MAX_ASPECT:
        problems.append(
            f"The image is {width}×{height} (ratio {aspect:.2f}); Instagram accepts "
            f"{INSTAGRAM_MIN_ASPECT} to {INSTAGRAM_MAX_ASPECT}."
        )
    return problems
