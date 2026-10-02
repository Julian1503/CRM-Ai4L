"""Worker protocol v1 — the Python mirror of src/lib/content-studio/types.ts.

Field names follow the TypeScript contract exactly (camelCase on the wire, snake_case
in Python). Both sides test against shared/content-contracts/fixtures, so drift fails a
test on whichever side changed (docs/CONTENT_STUDIO_CONTRACTS.md).

Unknown fields are ignored at runtime so the CRM can add optional fields without taking
the worker down; the contract tests use a round-trip check to catch drift instead.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

WORKER_PROTOCOL_VERSION = "v1"

ContentChannel = Literal["facebook", "instagram", "linkedin", "email"]
SocialPlatform = Literal["facebook", "instagram", "linkedin"]
JobKind = Literal["generate_text", "generate_image", "ingest_asset", "publish_social"]
SocialProvider = Literal["meta", "linkedin", "mock"]
SocialAuthorKind = Literal["page", "instagram_business", "organization", "member"]
FailOutcome = Literal["retry", "failed", "uncertain"]
ImageMime = Literal["image/jpeg", "image/png", "image/webp"]
RenditionPurpose = Literal["social", "email"]

SOCIAL_PLATFORMS: tuple[SocialPlatform, ...] = ("facebook", "instagram", "linkedin")
WORKER_OPS = ("claim", "heartbeat", "context", "checkpoint", "begin-dispatch", "complete", "fail")


class WireModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="ignore",
        frozen=True,
    )

    def to_wire(self) -> dict[str, Any]:
        """JSON-ready dict with camelCase keys; optional fields left unset are omitted."""
        return self.model_dump(mode="json", by_alias=True, exclude_unset=True)


# --- Domain --------------------------------------------------------------------


class PlatformLimits(WireModel):
    max_chars: int
    max_hashtags: int
    max_images: int
    requires_image: bool


class ContentBrief(WireModel):
    topic: str
    audience: str | None = None
    objective: str | None = None
    notes: str | None = None
    reference_url: str | None = None
    source_facts: list[str] | None = None


class ApprovedFact(WireModel):
    id: str
    text: str
    source: str | None = None


class ChannelRule(WireModel):
    cta: str | None = None
    structure: str | None = None


class BrandProfile(WireModel):
    id: str
    slug: str
    name: str
    tone: str
    audience: str
    region: str
    approved_facts: list[ApprovedFact]
    channel_rules: dict[ContentChannel, ChannelRule]
    hashtag_seeds: list[str]
    image_direction: str
    allowed_link_origins: list[str]


class RevisionAssetRef(WireModel):
    asset_id: str
    alt: str
    order: int


class RevisionContent(WireModel):
    body: str
    hashtags: list[str]
    call_to_action: str | None
    link_url: str | None
    fields: dict[str, str]
    assets: list[RevisionAssetRef]


class AssetFile(WireModel):
    path: str
    mime_type: ImageMime
    byte_size: int
    width: int
    height: int
    checksum: str


# --- Job inputs ------------------------------------------------------------------


class GenerateTextInput(WireModel):
    item_id: str
    channels: list[ContentChannel]
    styles_per_channel: int
    brief: ContentBrief
    variant_id: str | None = None
    base_revision_id: str | None = None
    instruction: str | None = None


class GenerateImageInput(WireModel):
    item_id: str
    prompt: str
    count: int
    quality: Literal["low", "medium", "high"]


class IngestAssetInput(WireModel):
    asset_id: str
    quarantine_path: str


class PublishSocialInput(WireModel):
    publication_id: str


JobInput = GenerateTextInput | GenerateImageInput | IngestAssetInput | PublishSocialInput

_INPUT_BY_KIND: dict[str, type[WireModel]] = {
    "generate_text": GenerateTextInput,
    "generate_image": GenerateImageInput,
    "ingest_asset": IngestAssetInput,
    "publish_social": PublishSocialInput,
}


# --- Protocol envelopes ---------------------------------------------------------------


class WorkerClaimRequest(WireModel):
    worker_id: str
    kinds: list[JobKind]
    limit: int
    lease_seconds: int | None = None


class ClaimedJob(WireModel):
    job_id: str
    kind: JobKind
    claim_token: str
    attempt: int
    input: JobInput
    checkpoint: dict[str, Any]

    @model_validator(mode="before")
    @classmethod
    def _input_by_kind(cls, data: Any) -> Any:
        """The input union is untagged; the job kind says which shape it is."""
        if isinstance(data, dict):
            model = _INPUT_BY_KIND.get(str(data.get("kind")))
            raw = data.get("input")
            if model is not None and isinstance(raw, dict):
                return {**data, "input": model.model_validate(raw)}
        return data


class WorkerClaimResponse(WireModel):
    jobs: list[ClaimedJob]


class WorkerJobRef(WireModel):
    job_id: str
    claim_token: str


class WorkerHeartbeatResponse(WireModel):
    state: Literal["ok", "cancel_requested", "lost"]


class WorkerCheckpointRequest(WorkerJobRef):
    checkpoint: dict[str, Any]


class WorkerBeginDispatchResponse(WireModel):
    decision: Literal["go", "lost", "refused"]


class WorkerFailRequest(WorkerJobRef):
    outcome: FailOutcome
    error_code: str
    message: str
    provider_request_id: str | None = None


class WorkerAckResponse(WireModel):
    accepted: bool


# --- Job context -------------------------------------------------------------------------


class SignedUpload(WireModel):
    path: str
    signed_url: str
    token: str


class GenerateTextContext(WireModel):
    kind: Literal["generate_text"]
    brand: BrandProfile
    input: GenerateTextInput
    base_revision: RevisionContent | None
    platform_limits: dict[ContentChannel, PlatformLimits]


class GenerateImageContext(WireModel):
    kind: Literal["generate_image"]
    brand: BrandProfile
    input: GenerateImageInput
    upload_prefix: str
    uploads: list[SignedUpload]


class IngestSource(WireModel):
    signed_url: str
    mime_type: str
    byte_size: int
    filename: str | None


class IngestAssetContext(WireModel):
    kind: Literal["ingest_asset"]
    asset_id: str
    source: IngestSource
    upload_prefix: str
    uploads: list[SignedUpload]
    max_dimension: int


class PublishImage(WireModel):
    url: str
    alt: str
    mime_type: str
    width: int
    height: int


class PublishAccount(WireModel):
    id: str
    provider: SocialProvider
    external_id: str
    author_kind: SocialAuthorKind
    display_name: str
    access_token: str = Field(repr=False)


class PublishSocialContext(WireModel):
    kind: Literal["publish_social"]
    publication_id: str
    platform: SocialPlatform
    account: PublishAccount
    text: str
    link_url: str | None
    images: list[PublishImage]
    checkpoint: dict[str, Any]


JobContext = Annotated[
    GenerateTextContext | GenerateImageContext | IngestAssetContext | PublishSocialContext,
    Field(discriminator="kind"),
]


class _ContextEnvelope(BaseModel):
    context: JobContext


def parse_job_context(
    data: Any,
) -> GenerateTextContext | GenerateImageContext | IngestAssetContext | PublishSocialContext:
    """Accept the context either bare or wrapped as ``{"context": …}``."""
    if isinstance(data, dict) and "kind" not in data and isinstance(data.get("context"), dict):
        data = data["context"]
    return _ContextEnvelope.model_validate({"context": data}).context


# --- Job results -----------------------------------------------------------------------------


class GeneratedVariant(WireModel):
    channel: ContentChannel
    style: str
    body: str
    hashtags: list[str]
    call_to_action: str | None
    link_url: str | None = None
    fields: dict[str, str] | None = None
    violations: list[str]
    prompt_version: str | None = None


class GenerationFailure(WireModel):
    channel: ContentChannel
    error_code: str
    message: str


class GenerateTextResult(WireModel):
    variants: list[GeneratedVariant]
    failures: list[GenerationFailure]
    prompt_version: str
    model: str
    provider_request_id: str | None = None
    usage: dict[str, int] | None = None


class AssetFiles(WireModel):
    original: AssetFile
    renditions: dict[RenditionPurpose, AssetFile]


class GeneratedAsset(WireModel):
    files: AssetFiles
    alt: str | None = None


class GenerateImageResult(WireModel):
    assets: list[GeneratedAsset]
    model: str
    provider_request_id: str | None = None
    usage: dict[str, int] | None = None


class IngestAssetReady(WireModel):
    status: Literal["ready"]
    files: AssetFiles


class IngestAssetRejected(WireModel):
    status: Literal["rejected"]
    reason: str


IngestAssetResult = Annotated[IngestAssetReady | IngestAssetRejected, Field(discriminator="status")]


class PublishSocialResult(WireModel):
    external_id: str
    permalink: str | None
    provider_request_id: str | None = None


JobResult = (
    GenerateTextResult | GenerateImageResult | IngestAssetReady | IngestAssetRejected | PublishSocialResult
)


class WorkerCompleteRequest(WorkerJobRef):
    result: dict[str, Any]
