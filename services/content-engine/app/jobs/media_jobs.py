"""ingest_asset and generate_image handlers.

ingest_asset: download the quarantined upload (byte cap) → normalise (decode, strip
metadata, cap dimensions, re-encode) → original + social + email renditions → upload each
through the CRM's signed upload URLs → complete. An unusable file completes as
``{status: 'rejected', reason}``; no begin-dispatch (no external effect).

generate_image: build the prompt → begin-dispatch → one provider call per image →
the same normalisation and renditions → upload under ``generated/<jobId>/<n>/`` →
complete with every image that succeeded (1..4).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from app.contracts import (
    GeneratedAsset,
    GenerateImageContext,
    GenerateImageResult,
    IngestAssetContext,
    IngestAssetReady,
    IngestAssetRejected,
)
from app.generation.images import ImageResult
from app.generation.llm import LLMError, classify_error
from app.generation.prompts import render_image_prompt
from app.jobs.deps import Deps
from app.jobs.generate_text import failure_outcome
from app.jobs.session import JobFailure, JobSession
from app.media.ingest import MediaRejectedError, normalise_upload
from app.media.renditions import (
    UploadTargetMissing,
    build_renditions,
    generated_directories,
    store_renditions,
)
from app.media.storage import SourceTooLarge, StorageError
from app.redact import redact

logger = logging.getLogger(__name__)

MAX_ALT_CHARS = 300


def _storage_failure(exc: StorageError) -> JobFailure:
    return JobFailure("retry" if exc.retryable else "failed", "storage_error", str(exc))


async def handle_ingest(session: JobSession, context: IngestAssetContext, deps: Deps) -> dict[str, Any]:
    limit = min(deps.settings.media_max_source_bytes, 15 * 1024 * 1024)
    try:
        data = await deps.storage.download(context.source.signed_url, max_bytes=limit)
    except SourceTooLarge as exc:
        return IngestAssetRejected(status="rejected", reason=str(exc)).to_wire()
    except StorageError as exc:
        raise _storage_failure(exc) from None
    session.ensure_can_continue()
    try:
        normalised = normalise_upload(
            data, filename=context.source.filename, max_dimension=context.max_dimension
        )
        renditions = build_renditions(normalised)
    except MediaRejectedError as exc:
        return IngestAssetRejected(status="rejected", reason=str(exc)).to_wire()
    session.ensure_can_continue()
    try:
        files = await store_renditions(deps.storage, context.uploads, context.upload_prefix, renditions)
    except UploadTargetMissing as exc:
        raise JobFailure("failed", "upload_target_missing", str(exc)) from None
    except StorageError as exc:
        raise _storage_failure(exc) from None
    return IngestAssetReady(status="ready", files=files).to_wire()


async def handle_generate_image(
    session: JobSession, context: GenerateImageContext, deps: Deps
) -> dict[str, Any]:
    count = max(1, min(context.input.count, 4))
    directories = generated_directories(context.uploads, context.upload_prefix)
    if len(directories) < count:
        raise JobFailure(
            "failed", "upload_target_missing", f"{count} images requested, {len(directories)} targets."
        )
    try:
        client = deps.image_client()
    except LLMError as exc:
        raise JobFailure("failed", f"image_{exc.kind}", str(exc)) from None
    prompt = render_image_prompt(context.brand, context.input.prompt)

    await session.begin_dispatch()
    results = await asyncio.gather(
        *(client.generate_image(prompt, quality=context.input.quality) for _ in range(count)),
        return_exceptions=True,
    )
    images = [result for result in results if isinstance(result, ImageResult)]
    errors = [result for result in results if isinstance(result, BaseException)]
    for error in errors:
        logger.warning("Job %s: image generation failed: %s", session.job_id, redact(error))
    if not images:
        kinds = [classify_error(error) for error in errors]
        raise JobFailure(failure_outcome(kinds), f"image_{kinds[0]}", redact(errors[0]))  # type: ignore[arg-type]

    assets: list[GeneratedAsset] = []
    for image, directory in zip(images, directories, strict=False):
        try:
            renditions = build_renditions(normalise_upload(image.data))
            files = await store_renditions(deps.storage, context.uploads, directory, renditions)
        except MediaRejectedError as exc:
            raise JobFailure("failed", "image_invalid", str(exc)) from None
        except UploadTargetMissing as exc:
            raise JobFailure("failed", "upload_target_missing", str(exc)) from None
        except StorageError as exc:
            raise _storage_failure(exc) from None
        assets.append(GeneratedAsset(files=files, alt=context.input.prompt[:MAX_ALT_CHARS]))

    usage: dict[str, int] = {}
    for image in images:
        for key, value in image.usage.items():
            usage[key] = usage.get(key, 0) + value
    return GenerateImageResult(
        assets=assets,
        model=client.model_name,
        provider_request_id=next((image.request_id for image in images if image.request_id), None),
        usage=usage or None,
    ).to_wire()
