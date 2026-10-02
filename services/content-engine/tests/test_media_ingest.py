"""Upload ingest (ported from WRCC tests/test_media_ingest.py): what we refuse and strip.

Every assertion here is about bytes that arrive from outside and later leave
through an endpoint with no authentication on it. The EXIF test is the one that
matters most: a phone photo carries the coordinates of wherever it was taken,
and nothing downstream would ever notice them going out.
"""

from __future__ import annotations

import io

import piexif
import pytest
from PIL import Image

from app.media.ingest import (
    MAX_PIXELS,
    MediaRejectedError,
    describe_generated,
    extension_for,
    normalise_upload,
    sanitise_filename,
)

JPEG_MAGIC = b"\xff\xd8\xff"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def _encode(image: Image.Image, fmt: str, **kwargs) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format=fmt, **kwargs)
    return buffer.getvalue()


def _photo(width: int = 800, height: int = 600) -> bytes:
    return _encode(Image.new("RGB", (width, height), (40, 90, 140)), "JPEG")


def _with_alpha(width: int = 400, height: int = 400) -> bytes:
    return _encode(Image.new("RGBA", (width, height), (255, 0, 0, 128)), "PNG")


# ── what we refuse ──


def test_empty_upload_is_refused() -> None:
    with pytest.raises(MediaRejectedError, match="empty"):
        normalise_upload(b"")


def test_a_non_image_is_refused_however_it_is_labelled() -> None:
    # The caller's content-type never reaches this function; format is decided
    # from the decoded header, which is the whole point.
    with pytest.raises(MediaRejectedError, match="not an image"):
        normalise_upload(b"GIF89a nope, this is a text file", filename="photo.png")


def test_a_truncated_image_is_refused() -> None:
    intact = _photo()
    with pytest.raises(MediaRejectedError):
        normalise_upload(intact[: len(intact) // 2])


def test_an_unsupported_format_names_what_to_convert() -> None:
    gif = _encode(Image.new("P", (50, 50)), "GIF")
    with pytest.raises(MediaRejectedError, match="GIF is not supported"):
        normalise_upload(gif)


def test_a_decompression_bomb_is_refused_before_it_is_decoded(monkeypatch) -> None:
    # A real 50 MP file would make the test suite slow and memory-hungry, so
    # the *reported* size is what is oversized here — which is exactly what the
    # guard reads, since it checks the header before any full decode.
    class _HugeHeader(Image.Image):
        pass

    data = _photo(100, 100)

    original_open = Image.open

    def fake_open(fp, *args, **kwargs):
        image = original_open(fp, *args, **kwargs)
        image._size = (MAX_PIXELS, 2)  # type: ignore[attr-defined]
        return image

    monkeypatch.setattr(Image, "open", fake_open)
    with pytest.raises(MediaRejectedError, match="megapixels"):
        normalise_upload(data)


# ── what we strip ──


def test_gps_coordinates_do_not_survive_ingest() -> None:
    # The single most consequential thing this pipeline does. These bytes end
    # up on an endpoint that has no session on it.
    exif = piexif.dump(
        {
            "GPS": {
                piexif.GPSIFD.GPSLatitudeRef: b"S",
                piexif.GPSIFD.GPSLatitude: ((34, 1), (25, 1), (0, 1)),
                piexif.GPSIFD.GPSLongitudeRef: b"E",
                piexif.GPSIFD.GPSLongitude: ((146, 1), (3, 1), (0, 1)),
            },
            "0th": {piexif.ImageIFD.Make: b"ACME Phone"},
        }
    )
    buffer = io.BytesIO()
    Image.new("RGB", (600, 400), (10, 10, 10)).save(buffer, format="JPEG", exif=exif)
    original = buffer.getvalue()
    assert b"ACME Phone" in original  # the fixture really does carry metadata

    result = normalise_upload(original, filename="beach.jpg")

    with Image.open(io.BytesIO(result.data)) as stored:
        assert not stored.getexif()
        assert "exif" not in stored.info
    assert b"ACME Phone" not in result.data


# ── what we keep ──


def test_a_photograph_is_stored_as_jpeg() -> None:
    result = normalise_upload(_photo(), filename="team.jpg")

    assert result.mime_type == "image/jpeg"
    assert result.data.startswith(JPEG_MAGIC)
    assert (result.width, result.height) == (800, 600)
    assert result.byte_size == len(result.data)


def test_transparency_is_preserved_rather_than_flattened() -> None:
    # A logo on a transparent background must not be flattened here. The
    # publish path flattens onto white when a network needs JPEG; doing it
    # twice would bake in a choice the operator has not made yet.
    result = normalise_upload(_with_alpha(), filename="logo.png")

    assert result.mime_type == "image/png"
    assert result.data.startswith(PNG_MAGIC)
    with Image.open(io.BytesIO(result.data)) as stored:
        assert stored.mode == "RGBA"


def test_a_webp_upload_is_re_encoded_to_jpeg() -> None:
    webp = _encode(Image.new("RGB", (500, 500), (1, 2, 3)), "WEBP")

    result = normalise_upload(webp, filename="photo.webp")

    assert result.mime_type == "image/jpeg"
    assert result.data.startswith(JPEG_MAGIC)


def test_an_oversized_image_is_downscaled_on_its_long_edge() -> None:
    result = normalise_upload(_photo(4000, 2000), max_dimension=2048)

    assert result.width == 2048
    assert result.height == 1024  # aspect ratio preserved


def test_an_image_within_the_limit_is_not_upscaled() -> None:
    result = normalise_upload(_photo(320, 240), max_dimension=2048)

    assert (result.width, result.height) == (320, 240)


def test_identical_bytes_produce_an_identical_checksum() -> None:
    # What makes re-uploading the same file attach the existing asset instead
    # of storing a second copy of it.
    first = normalise_upload(_photo(), filename="a.jpg")
    second = normalise_upload(_photo(), filename="b-different-name.jpg")

    assert first.checksum == second.checksum
    assert len(first.checksum) == 64


def test_different_images_do_not_collide() -> None:
    assert normalise_upload(_photo(800, 600)).checksum != normalise_upload(_photo(801, 600)).checksum


# ── filenames ──


@pytest.mark.parametrize(
    ("supplied", "expected"),
    [
        ("holiday photo.jpg", "holiday photo.jpg"),
        # A browser may send a full path; the tail is the only interesting part.
        ("C:\\Users\\jo\\Pictures\\shot.png", "shot.png"),
        ("../../etc/passwd", "passwd"),
        ("we<ird>|name?.jpg", "we_ird__name_.jpg"),
        ("", None),
        (None, None),
    ],
)
def test_filenames_are_reduced_to_something_safe_to_display(supplied, expected) -> None:
    assert sanitise_filename(supplied) == expected


def test_a_very_long_filename_is_truncated() -> None:
    assert len(sanitise_filename("a" * 500 + ".jpg") or "") == 120


# ── generated images ──


def test_generated_bytes_are_measured_not_re_encoded() -> None:
    # Our own PNG needs neither stripping nor resizing; running it through the
    # upload pipeline would re-compress a file that was already correct.
    png = _encode(Image.new("RGB", (1024, 1024), (7, 7, 7)), "PNG")

    result = describe_generated(png)

    assert result.data is png
    assert result.mime_type == "image/png"
    assert (result.width, result.height) == (1024, 1024)


def test_extension_follows_the_stored_type() -> None:
    assert extension_for("image/jpeg") == "jpg"
    assert extension_for("image/png") == "png"
