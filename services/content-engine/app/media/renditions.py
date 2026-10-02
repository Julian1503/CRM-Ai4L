"""Build and store an asset's files: original + social + email renditions.

Paths come from the CRM (``SignedUpload.path``); the worker never invents one. Upload
targets are matched by file stem (``original``, ``social``, ``email``) inside the
expected directory, preferring the one whose extension matches the encoded format. The
CRM does not know ahead of time whether an image keeps transparency (PNG) or not (JPEG),
so it may offer both ``original.jpg`` and ``original.png``; only one is written.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.contracts import AssetFile, AssetFiles, SignedUpload
from app.media.ingest import NormalisedImage
from app.media.publish_formats import EncodedImage, email_rendition, to_jpeg
from app.media.storage import StorageClient

_EXTENSIONS = {"image/jpeg": ("jpg", "jpeg"), "image/png": ("png",), "image/webp": ("webp",)}


class UploadTargetMissing(ValueError):
    """The CRM context did not offer a signed upload for a file we must write."""


@dataclass(frozen=True, slots=True)
class RenditionSet:
    original: EncodedImage
    social: EncodedImage
    email: EncodedImage


def build_renditions(normalised: NormalisedImage) -> RenditionSet:
    original = EncodedImage(normalised.data, normalised.mime_type, normalised.width, normalised.height)
    return RenditionSet(
        original=original,
        social=to_jpeg(normalised.data),
        email=email_rendition(normalised.data),
    )


def pick_upload(uploads: list[SignedUpload], directory: str, stem: str, mime_type: str) -> SignedUpload:
    base = directory if directory.endswith("/") else f"{directory}/"
    candidates = [
        upload
        for upload in uploads
        if upload.path.startswith(base)
        and "/" not in upload.path[len(base) :]
        and upload.path[len(base) :].rsplit(".", 1)[0] == stem
    ]
    for upload in candidates:
        if upload.path.rsplit(".", 1)[-1].lower() in _EXTENSIONS.get(mime_type, ()):
            return upload
    if candidates:
        return candidates[0]
    raise UploadTargetMissing(f"No signed upload offered for {base}{stem}.*")


def generated_directories(uploads: list[SignedUpload], prefix: str) -> list[str]:
    """``generated/<jobId>/<n>/`` directories offered by the CRM, in numeric order."""
    base = prefix if prefix.endswith("/") else f"{prefix}/"
    names: set[str] = set()
    for upload in uploads:
        rest = upload.path[len(base) :] if upload.path.startswith(base) else ""
        if "/" in rest:
            names.add(rest.split("/", 1)[0])
    ordered = sorted(names, key=lambda name: (0, int(name)) if name.isdigit() else (1, 0))
    return [f"{base}{name}/" for name in ordered]


def _asset_file(upload: SignedUpload, image: EncodedImage) -> AssetFile:
    return AssetFile(
        path=upload.path,
        mime_type=image.mime_type,  # type: ignore[arg-type]
        byte_size=image.byte_size,
        width=image.width,
        height=image.height,
        checksum=image.checksum,
    )


async def store_renditions(
    storage: StorageClient, uploads: list[SignedUpload], directory: str, renditions: RenditionSet
) -> AssetFiles:
    """Upload the three files and describe them exactly as stored (sha256 of the bytes)."""
    plan = {
        "original": renditions.original,
        "social": renditions.social,
        "email": renditions.email,
    }
    targets = {stem: pick_upload(uploads, directory, stem, image.mime_type) for stem, image in plan.items()}
    for stem, image in plan.items():
        await storage.upload(targets[stem], image.data, image.mime_type)
    return AssetFiles(
        original=_asset_file(targets["original"], renditions.original),
        renditions={
            "social": _asset_file(targets["social"], renditions.social),
            "email": _asset_file(targets["email"], renditions.email),
        },
    )
