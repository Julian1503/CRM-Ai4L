"""In-memory fakes for the CRM bridge, storage and providers."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

import httpx
from pydantic import BaseModel

from app.contracts import ClaimedJob, parse_job_context
from app.generation.images import MockImageClient
from app.generation.llm import LLMError, LLMResponse, MockLLMClient
from app.generation.prompts import DraftContext
from app.jobs.deps import Deps
from app.media.storage import StorageClient
from app.social.publishers.base import PublishRequest, PublishResult
from tests.conftest import load_fixture, make_settings


@dataclass
class FakeCrm:
    """Implements the CrmClient surface the worker uses, recording every call."""

    context_data: dict[str, Any]
    heartbeat_states: list[str] = field(default_factory=list)
    begin_decision: str = "go"
    complete_accepted: bool = True
    calls: list[tuple[str, Any]] = field(default_factory=list)
    claim_batches: list[list[ClaimedJob]] = field(default_factory=list)

    def ops(self) -> list[str]:
        return [name for name, _ in self.calls]

    def payload(self, op: str) -> Any:
        return next(data for name, data in self.calls if name == op)

    async def claim(
        self, worker_id: str, kinds: list[str], limit: int, lease_seconds: int
    ) -> list[ClaimedJob]:
        self.calls.append(("claim", {"limit": limit, "kinds": kinds}))
        return self.claim_batches.pop(0) if self.claim_batches else []

    async def heartbeat(self, job_id: str, claim_token: str) -> str:
        self.calls.append(("heartbeat", None))
        return self.heartbeat_states.pop(0) if self.heartbeat_states else "ok"

    async def context(self, job_id: str, claim_token: str):  # noqa: ANN201
        self.calls.append(("context", None))
        return parse_job_context(self.context_data)

    async def checkpoint(self, job_id: str, claim_token: str, checkpoint: dict[str, Any]) -> bool:
        self.calls.append(("checkpoint", checkpoint))
        return True

    async def begin_dispatch(self, job_id: str, claim_token: str) -> str:
        self.calls.append(("begin-dispatch", None))
        return self.begin_decision

    async def complete(self, job_id: str, claim_token: str, result: dict[str, Any]) -> bool:
        self.calls.append(("complete", result))
        return self.complete_accepted

    async def fail(self, job_id: str, claim_token: str, **kwargs: Any) -> bool:
        self.calls.append(("fail", kwargs))
        return True


def claimed(kind: str, input_data: dict[str, Any], checkpoint: dict | None = None) -> ClaimedJob:
    return ClaimedJob.model_validate(
        {
            "jobId": "11111111-1111-4111-8111-111111111111",
            "kind": kind,
            "claimToken": "22222222-2222-4222-8222-222222222222",
            "attempt": 1,
            "input": input_data,
            "checkpoint": checkpoint or {},
        }
    )


class FakePublisher:
    def __init__(
        self, *, dispatch_error: BaseException | None = None, prepare_gate: asyncio.Event | None = None
    ):
        self.prepared: list[dict] = []
        self.dispatches = 0
        self._dispatch_error = dispatch_error
        self._gate = prepare_gate

    async def prepare(self, request: PublishRequest, checkpoint: dict[str, Any]) -> dict[str, Any]:
        if self._gate is not None:
            await self._gate.wait()
        prepared = {"fingerprint": request.fingerprint(), "photoIds": ["p1"]}
        self.prepared.append(prepared)
        return prepared

    async def dispatch(self, request: PublishRequest, prepared: dict[str, Any]) -> PublishResult:
        self.dispatches += 1
        if self._dispatch_error is not None:
            raise self._dispatch_error
        return PublishResult(external_id="post-1", permalink="https://www.facebook.com/post-1")


class ScriptedLLM:
    """Mock copy, but channels listed in ``fail`` raise the given error kind."""

    model_name = "scripted"

    def __init__(self, fail: dict[str, str] | None = None) -> None:
        self._fail = fail or {}
        self._mock = MockLLMClient()
        self.calls = 0

    async def complete_json(self, prompt: str, schema: type[BaseModel], ctx: DraftContext) -> LLMResponse:
        self.calls += 1
        kind = self._fail.get(ctx.channel)
        if kind:
            raise LLMError(kind, f"{ctx.channel} failed")  # type: ignore[arg-type]
        return await self._mock.complete_json(prompt, schema, ctx)


class StorageRecorder:
    """httpx transport serving one download and recording signed-URL PUTs."""

    def __init__(self, source: bytes = b"") -> None:
        self.source = source
        self.puts: dict[str, tuple[bytes, str]] = {}

    def handler(self, request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, content=self.source)
        path = request.url.path.split("/content-library/", 1)[-1]
        self.puts[path] = (request.content, request.headers["content-type"])
        return httpx.Response(200, json={"Key": path})

    def client(self) -> StorageClient:
        return StorageClient(transport=httpx.MockTransport(self.handler))


def make_deps(**overrides: Any) -> Deps:
    settings = overrides.pop("settings", None) or make_settings()
    publisher = overrides.pop("publisher", None) or FakePublisher()
    values: dict[str, Any] = {
        "settings": settings,
        "llm": MockLLMClient(),
        "image_client": MockImageClient,
        "storage": StorageRecorder().client(),
        "publisher_for": lambda _platform, _provider: publisher,
    }
    values.update(overrides)
    return Deps(**values)


def generate_text_context(**input_overrides: Any) -> dict[str, Any]:
    data = load_fixture("context-generate-text.json")
    data["input"] = {**data["input"], **input_overrides}
    data["input"]["brief"] = {k: v for k, v in data["input"]["brief"].items() if k != "referenceUrl"}
    return data
