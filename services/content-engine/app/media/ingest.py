"""Upload ingest — the only place a caller's bytes become bytes we store.

Ported almost verbatim from WRCC ``backend/app/content/ingest.py`` (D10). Nothing that
arrives here is stored as it arrived: every accepted upload is decoded to raw pixels and
re-encoded, which settles three problems at once:

*Privacy.* A phone photo carries GPS coordinates in EXIF, and published copies are
served from a public Storage bucket. Re-encoding from pixel data leaves no metadata.

*Size.* The long edge is capped (``maxDimension`` from the job context).

*Trust.* The declared content type and filename are claims made by the caller. Format
is decided here by decoding the header, and a file that is both a valid image and
something else cannot survive being re-encoded.

Pure functions — no I/O beyond PIL. The ingest_asset handler owns download and upload.
"""

from __future__ import annotations

import hashlib
import io
import re
from dataclasses import dataclass

from PIL import Image, UnidentifiedImageError

# Formats we are willing to decode. Anything else is refused by name so the
# operator learns what to convert, rather than being told "invalid image".
ACCEPTED_FORMATS = {"PNG", "JPEG", "WEBP"}

# Long edge after normalisation. Larger than any of the three networks renders
# (Instagram tops out at 1440), with headroom for a future one.
DEFAULT_MAX_DIMENSION = 2048

JPEG_QUALITY = 90

# A pixel count no legitimate social image reaches. Checked from the header
# before any full decode: a 100 MP PNG is a memory exhaustion, not a picture.
MAX_PIXELS = 50_000_000

MIME_PNG = "image/png"
MIME_JPEG = "image/jpeg"

_UNSAFE_FILENAME = re.compile(r"[^A-Za-z0-9._ -]")


class MediaRejectedError(ValueError):
    """The upload cannot be accepted. The message is shown to the operator."""


@dataclass(frozen=True, slots=True)
class NormalisedImage:
    """What gets persisted, once the caller's bytes have been made safe."""

    data: bytes
    mime_type: str
    width: int
    height: int
    checksum: str
    filename: str | None

    @property
    def byte_size(self) -> int:
        return len(self.data)


def sanitise_filename(filename: str | None) -> str | None:
    """Reduce a caller-supplied name to something safe to display.

    Display is all it is ever used for — the download name is derived from the
    asset id, and no path is ever built from this — but a name that renders
    into the UI still has no business carrying control characters or slashes.
    """
    if not filename:
        return None
    # Take the last segment under either separator: a browser may send a full
    # path, and "../../etc/passwd" should read as "passwd", not as a traversal.
    tail = filename.replace("\\", "/").split("/")[-1]
    cleaned = _UNSAFE_FILENAME.sub("_", tail).strip(" .")
    return cleaned[:120] or None


def _open(data: bytes) -> Image.Image:
    try:
        return Image.open(io.BytesIO(data))
    except Image.DecompressionBombError as exc:
        # PIL's own guard fires before ours for truly enormous headers.
        raise MediaRejectedError(
            "That image is larger than we can process. Resize it below 50 megapixels first."
        ) from exc
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise MediaRejectedError(
            "That file is not an image we can read. Upload a PNG, JPEG or WebP."
        ) from exc


def _has_alpha(image: Image.Image) -> bool:
    return image.mode in ("RGBA", "LA", "PA") or "transparency" in image.info


def normalise_upload(
    data: bytes,
    *,
    filename: str | None = None,
    max_dimension: int = DEFAULT_MAX_DIMENSION,
) -> NormalisedImage:
    """Validate, strip and re-encode one uploaded file.

    Raises ``MediaRejectedError`` with a message written for the person who
    chose the file, never a stack trace or a PIL exception.
    """
    if not data:
        raise MediaRejectedError("That file is empty.")

    # verify() is the cheap structural check, and it consumes the image object
    # — hence the second open below for the actual work. Skipping it would let
    # a truncated file through to a decode that fails much further in.
    probe = _open(data)
    declared_format = (probe.format or "").upper()
    width, height = probe.size
    try:
        probe.verify()
    except Exception as exc:  # noqa: BLE001 - PIL raises a wide range here
        raise MediaRejectedError("That image file is damaged or incomplete.") from exc
    finally:
        probe.close()

    if declared_format not in ACCEPTED_FORMATS:
        raise MediaRejectedError(
            f"{declared_format or 'That format'} is not supported. Upload a PNG, JPEG or WebP."
        )
    if width <= 0 or height <= 0:
        raise MediaRejectedError("That image reports no dimensions.")
    if width * height > MAX_PIXELS:
        raise MediaRejectedError(
            f"That image is {width}×{height}, which is larger than we can "
            "process. Resize it below 50 megapixels first."
        )

    try:
        with _open(data) as image:
            keep_alpha = _has_alpha(image)
            # Converting first forces the decode; loading pixels is also what
            # discards every EXIF/ICC block, since nothing but the pixels
            # survives into the new image below.
            pixels = image.convert("RGBA" if keep_alpha else "RGB")

            longest = max(pixels.width, pixels.height)
            if longest > max_dimension:
                scale = max_dimension / longest
                pixels = pixels.resize(
                    (
                        max(1, round(pixels.width * scale)),
                        max(1, round(pixels.height * scale)),
                    ),
                    Image.Resampling.LANCZOS,
                )

            buffer = io.BytesIO()
            if keep_alpha:
                # A logo on a transparent background must not be flattened
                # here — the publish path already flattens onto white when a
                # network needs JPEG, and doing it twice would bake in a choice
                # the operator has not made yet.
                pixels.save(buffer, format="PNG", optimize=True)
                mime = MIME_PNG
            else:
                pixels.save(buffer, format="JPEG", quality=JPEG_QUALITY, optimize=True)
                mime = MIME_JPEG
            out = buffer.getvalue()
            out_size = pixels.size
    except MediaRejectedError:
        raise
    except Exception as exc:  # noqa: BLE001 - PIL raises OSError/ValueError/…
        # `verify()` above is a structural check, not a decode: a truncated
        # JPEG passes it and only fails here. Without this branch that lands on
        # the caller as a 500, when it is squarely a bad upload.
        raise MediaRejectedError(
            "That image could not be read all the way through — it is probably "
            "damaged or incompletely uploaded."
        ) from exc

    return NormalisedImage(
        data=out,
        mime_type=mime,
        width=out_size[0],
        height=out_size[1],
        checksum=hashlib.sha256(out).hexdigest(),
        filename=sanitise_filename(filename),
    )


def describe_generated(data: bytes) -> NormalisedImage:
    """Measure bytes we produced ourselves, without re-encoding them.

    The image client's PNG is already ours and already sized; running it
    through ``normalise_upload`` would re-compress a file that needs neither
    stripping nor resizing.
    """
    with _open(data) as image:
        width, height = image.size
    return NormalisedImage(
        data=data,
        mime_type=MIME_PNG,
        width=int(width),
        height=int(height),
        checksum=hashlib.sha256(data).hexdigest(),
        filename=None,
    )


def extension_for(mime_type: str) -> str:
    """File extension for a stored asset. Only two are ever produced."""
    return "jpg" if mime_type == MIME_JPEG else "png"
