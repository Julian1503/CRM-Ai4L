"""Every worker DTO fixture parses with contracts.py and round-trips byte-for-byte.

A round-trip that drops or renames a key means the Python mirror drifted from
src/lib/content-studio/types.ts (the TypeScript side validates the same fixtures).
"""

from __future__ import annotations

import pytest

from app.contracts import (
    GenerateTextResult,
    IngestAssetReady,
    IngestAssetRejected,
    PublishSocialResult,
    WorkerClaimResponse,
    parse_job_context,
)
from tests.conftest import FIXTURES, load_fixture

RESULT_MODELS = {
    "result-generate-text.json": GenerateTextResult,
    "result-ingest-asset.json": IngestAssetReady,
    "result-ingest-asset-rejected.json": IngestAssetRejected,
    "result-publish-social.json": PublishSocialResult,
}
CONTEXT_FIXTURES = ["context-generate-text.json", "context-ingest-asset.json", "context-publish-social.json"]


def test_every_worker_fixture_is_covered() -> None:
    names = {path.name for path in FIXTURES.glob("*.json")}
    dto_names = {name for name in names if name.startswith(("claim-", "context-", "result-"))}
    covered = set(RESULT_MODELS) | set(CONTEXT_FIXTURES) | {"claim-response.json"}
    assert dto_names == covered


def test_claim_response_round_trips() -> None:
    data = load_fixture("claim-response.json")
    parsed = WorkerClaimResponse.model_validate(data)
    assert [job.kind for job in parsed.jobs] == [
        "generate_text",
        "ingest_asset",
        "generate_image",
        "publish_social",
    ]
    assert parsed.to_wire() == data


def test_claimed_job_input_is_parsed_by_kind() -> None:
    parsed = WorkerClaimResponse.model_validate(load_fixture("claim-response.json"))
    assert type(parsed.jobs[0].input).__name__ == "GenerateTextInput"
    assert type(parsed.jobs[1].input).__name__ == "IngestAssetInput"
    assert type(parsed.jobs[2].input).__name__ == "GenerateImageInput"
    assert type(parsed.jobs[3].input).__name__ == "PublishSocialInput"


@pytest.mark.parametrize("name", CONTEXT_FIXTURES)
def test_context_fixture_round_trips(name: str) -> None:
    data = load_fixture(name)
    context = parse_job_context(data)
    assert context.kind == data["kind"]
    assert context.to_wire() == data


def test_context_may_arrive_wrapped() -> None:
    data = load_fixture("context-ingest-asset.json")
    assert parse_job_context({"context": data}).to_wire() == data


def test_publish_context_token_is_not_in_repr() -> None:
    context = parse_job_context(load_fixture("context-publish-social.json"))
    assert "test-token-not-real" not in repr(context)


@pytest.mark.parametrize(("name", "model"), sorted(RESULT_MODELS.items()))
def test_result_fixture_round_trips(name: str, model: type) -> None:
    data = load_fixture(name)
    assert model.model_validate(data).to_wire() == data
