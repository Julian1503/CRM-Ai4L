"""ingest_asset and generate_image handlers: renditions, uploads, checksums, rejections."""

from __future__ import annotations

import hashlib
import io

import pytest
from PIL import Image

from app.contracts import GenerateImageResult, IngestAssetReady, SignedUpload, parse_job_context
from app.jobs import media_jobs
from app.jobs.session import JobFailure, JobSession
from app.media.renditions import UploadTargetMissing, generated_directories, pick_upload
from app.media.storage import StorageClient
from tests.conftest import load_fixture
from tests.fakes import FakeCrm, StorageRecorder, claimed, make_deps


def jpeg_bytes(width: int = 3000, height: int = 2000) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), (30, 60, 90)).save(buffer, format="JPEG")
    return buffer.getvalue()


def png_with_alpha(width: int = 1600, height: int = 800) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGBA", (width, height), (255, 0, 0, 100)).save(buffer, format="PNG")
    return buffer.getvalue()


def storage_with(source: bytes) -> tuple[StorageRecorder, StorageClient]:
    recorder = StorageRecorder(source)
    return recorder, recorder.client()


def _session(kind: str) -> JobSession:
    crm = FakeCrm({})
    return JobSession(claimed(kind, {"assetId": "a", "quarantinePath": "q"}), crm, lease_seconds=30)  # type: ignore[arg-type]


def _ingest_context():  # noqa: ANN202
    return parse_job_context(load_fixture("context-ingest-asset.json"))


async def test_ingest_produces_original_social_and_email_with_real_checksums() -> None:
    recorder, storage = storage_with(jpeg_bytes())
    result = await media_jobs.handle_ingest(
        _session("ingest_asset"), _ingest_context(), make_deps(storage=storage)
    )

    ready = IngestAssetReady.model_validate(result)
    files = [ready.files.original, ready.files.renditions["social"], ready.files.renditions["email"]]
    for file in files:
        data, mime = recorder.puts[file.path]
        assert hashlib.sha256(data).hexdigest() == file.checksum
        assert file.byte_size == len(data) and file.mime_type == mime
        assert file.path.startswith(_ingest_context().upload_prefix)
    assert ready.files.original.width == 2048  # maxDimension
    assert ready.files.original.path.endswith("original.jpg")
    assert ready.files.renditions["social"].width == 1440
    assert ready.files.renditions["email"].width == 1200


async def test_transparency_keeps_png_for_original_and_email_but_social_is_jpeg() -> None:
    recorder, storage = storage_with(png_with_alpha())
    result = await media_jobs.handle_ingest(
        _session("ingest_asset"), _ingest_context(), make_deps(storage=storage)
    )
    ready = IngestAssetReady.model_validate(result)
    assert ready.files.original.path.endswith("original.png")
    assert ready.files.original.mime_type == "image/png"
    assert ready.files.renditions["email"].mime_type == "image/png"
    assert ready.files.renditions["social"].mime_type == "image/jpeg"
    assert len(recorder.puts) == 3


async def test_a_non_image_is_rejected_not_failed() -> None:
    recorder, storage = storage_with(b"GIF89a this is not an image at all")
    result = await media_jobs.handle_ingest(
        _session("ingest_asset"), _ingest_context(), make_deps(storage=storage)
    )
    assert result["status"] == "rejected"
    assert recorder.puts == {}


async def test_an_oversized_source_is_rejected() -> None:
    from tests.conftest import make_settings

    _recorder, storage = storage_with(jpeg_bytes(200, 200))
    deps = make_deps(storage=storage, settings=make_settings(media_max_source_bytes=100))
    result = await media_jobs.handle_ingest(_session("ingest_asset"), _ingest_context(), deps)
    assert result["status"] == "rejected"


async def test_generate_image_uploads_under_numbered_directories() -> None:
    job_prefix = "generated/11111111-1111-4111-8111-111111111111/"
    uploads = [
        {
            "path": f"{job_prefix}{n}/{stem}",
            "signedUrl": f"https://s.test/content-library/{job_prefix}{n}/{stem}?token=t",
            "token": "t",
        }
        for n in (0, 1)
        for stem in ("original.jpg", "original.png", "social.jpg", "email.jpg", "email.png")
    ]
    context = parse_job_context(
        {
            "kind": "generate_image",
            "brand": load_fixture("context-generate-text.json")["brand"],
            "input": {"itemId": "i", "prompt": "A calm office", "count": 2, "quality": "low"},
            "uploadPrefix": job_prefix,
            "uploads": uploads,
        }
    )
    recorder, storage = storage_with(b"")
    crm = FakeCrm({})
    session = JobSession(
        claimed("generate_image", {"itemId": "i", "prompt": "p", "count": 2, "quality": "low"}),
        crm,
        lease_seconds=30,
    )  # type: ignore[arg-type]

    result = GenerateImageResult.model_validate(
        await media_jobs.handle_generate_image(session, context, make_deps(storage=storage))
    )

    assert crm.ops() == ["begin-dispatch"]
    assert [asset.files.original.path for asset in result.assets] == [
        f"{job_prefix}0/original.jpg",
        f"{job_prefix}1/original.jpg",
    ]
    assert len(recorder.puts) == 6
    assert result.model == "mock"


async def test_generate_image_without_upload_targets_fails_before_dispatch() -> None:
    context = parse_job_context(
        {
            "kind": "generate_image",
            "brand": load_fixture("context-generate-text.json")["brand"],
            "input": {"itemId": "i", "prompt": "p", "count": 1, "quality": "low"},
            "uploadPrefix": "generated/j/",
            "uploads": [],
        }
    )
    crm = FakeCrm({})
    session = JobSession(
        claimed("generate_image", {"itemId": "i", "prompt": "p", "count": 1, "quality": "low"}),
        crm,
        lease_seconds=30,
    )  # type: ignore[arg-type]
    with pytest.raises(JobFailure):
        await media_jobs.handle_generate_image(session, context, make_deps())
    assert crm.ops() == []


def test_pick_upload_prefers_matching_extension_and_refuses_missing_targets() -> None:
    uploads = [
        SignedUpload(path="library/a/original.jpg", signed_url="https://x/1", token="t"),
        SignedUpload(path="library/a/original.png", signed_url="https://x/2", token="t"),
    ]
    assert pick_upload(uploads, "library/a/", "original", "image/png").path.endswith(".png")
    assert pick_upload(uploads, "library/a", "original", "image/jpeg").path.endswith(".jpg")
    with pytest.raises(UploadTargetMissing):
        pick_upload(uploads, "library/a/", "social", "image/jpeg")


def test_generated_directories_are_ordered_numerically() -> None:
    uploads = [
        SignedUpload(path=f"generated/j/{n}/original.jpg", signed_url="https://x", token="t")
        for n in (10, 2, 1)
    ]
    assert generated_directories(uploads, "generated/j/") == [
        "generated/j/1/",
        "generated/j/2/",
        "generated/j/10/",
    ]


async def test_storage_refuses_plain_http_unless_allowed() -> None:
    from app.media.storage import StorageError

    with pytest.raises(StorageError):
        await StorageClient().download("http://127.0.0.1:54321/x", max_bytes=10)
