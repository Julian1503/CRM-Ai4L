"""Worker state machine against a fake CRM: the order of protocol calls is the contract."""

from __future__ import annotations

import asyncio

import pytest

from app.contracts import IngestAssetReady, PublishSocialResult
from app.jobs.session import JobSession
from app.social.publishers.base import DispatchRejected, DispatchUncertain
from app.worker import JobRunner, Worker
from tests.conftest import load_fixture, make_settings
from tests.fakes import FakeCrm, FakePublisher, claimed, make_deps

PUBLISH_INPUT = {"publicationId": "55555555-5555-4555-8555-555555555555"}


@pytest.fixture(autouse=True)
def fast_heartbeat(monkeypatch) -> None:
    monkeypatch.setattr(JobSession, "heartbeat_interval", property(lambda self: 0.01))


async def _run(crm: FakeCrm, job, deps, shutdown: asyncio.Event | None = None) -> None:
    await JobRunner(crm, deps, shutdown=shutdown or asyncio.Event()).run(job)  # type: ignore[arg-type]


async def test_publish_runs_prepare_checkpoint_begin_dispatch_complete_in_order() -> None:
    crm = FakeCrm(load_fixture("context-publish-social.json"))
    publisher = FakePublisher()

    await _run(crm, claimed("publish_social", PUBLISH_INPUT), make_deps(publisher=publisher))

    protocol = [op for op in crm.ops() if op != "heartbeat"]
    assert protocol == ["context", "checkpoint", "begin-dispatch", "complete"]
    assert publisher.dispatches == 1
    result = PublishSocialResult.model_validate(crm.payload("complete"))
    assert result.external_id == "post-1"
    assert "prepared" in crm.payload("checkpoint")


async def test_the_access_token_never_reaches_the_crm_in_any_report() -> None:
    crm = FakeCrm(load_fixture("context-publish-social.json"))
    await _run(crm, claimed("publish_social", PUBLISH_INPUT), make_deps())
    reports = [data for name, data in crm.calls if name in ("checkpoint", "complete", "fail")]
    assert "test-token-not-real" not in repr(reports)


async def test_an_uncertain_dispatch_is_reported_uncertain_and_never_retried() -> None:
    crm = FakeCrm(load_fixture("context-publish-social.json"))
    publisher = FakePublisher(dispatch_error=DispatchUncertain("HTTP 502 while publishing"))

    await _run(crm, claimed("publish_social", PUBLISH_INPUT), make_deps(publisher=publisher))

    assert publisher.dispatches == 1
    assert crm.payload("fail")["outcome"] == "uncertain"
    assert "complete" not in crm.ops()


async def test_a_structured_rejection_on_dispatch_is_failed() -> None:
    crm = FakeCrm(load_fixture("context-publish-social.json"))
    publisher = FakePublisher(dispatch_error=DispatchRejected("bad token", code="reauth"))
    await _run(crm, claimed("publish_social", PUBLISH_INPUT), make_deps(publisher=publisher))
    assert crm.payload("fail")["outcome"] == "failed"
    assert crm.payload("fail")["error_code"] == "dispatch_reauth"


async def test_an_unexpected_dispatch_error_is_uncertain() -> None:
    crm = FakeCrm(load_fixture("context-publish-social.json"))
    publisher = FakePublisher(dispatch_error=KeyError("boom"))
    await _run(crm, claimed("publish_social", PUBLISH_INPUT), make_deps(publisher=publisher))
    assert publisher.dispatches == 1
    assert crm.payload("fail")["outcome"] == "uncertain"


async def test_a_refused_begin_dispatch_never_calls_the_provider_or_reports() -> None:
    crm = FakeCrm(load_fixture("context-publish-social.json"), begin_decision="refused")
    publisher = FakePublisher()
    await _run(crm, claimed("publish_social", PUBLISH_INPUT), make_deps(publisher=publisher))
    assert publisher.dispatches == 0
    assert "complete" not in crm.ops() and "fail" not in crm.ops()


async def test_cancel_requested_stops_before_dispatch() -> None:
    gate = asyncio.Event()
    crm = FakeCrm(load_fixture("context-publish-social.json"), heartbeat_states=["cancel_requested"])
    publisher = FakePublisher(prepare_gate=gate)

    async def release_after_heartbeat() -> None:
        while "heartbeat" not in crm.ops():
            await asyncio.sleep(0.005)
        gate.set()

    await asyncio.gather(
        _run(crm, claimed("publish_social", PUBLISH_INPUT), make_deps(publisher=publisher)),
        release_after_heartbeat(),
    )
    assert publisher.dispatches == 0
    assert "begin-dispatch" not in crm.ops()
    assert crm.payload("fail")["outcome"] == "retry"
    assert crm.payload("fail")["error_code"] == "cancelled"


async def test_a_lost_lease_stops_the_job_immediately_before_dispatch() -> None:
    crm = FakeCrm(load_fixture("context-publish-social.json"), heartbeat_states=["lost"])
    publisher = FakePublisher(prepare_gate=asyncio.Event())  # would block forever

    await asyncio.wait_for(
        _run(crm, claimed("publish_social", PUBLISH_INPUT), make_deps(publisher=publisher)), timeout=2
    )
    assert publisher.dispatches == 0
    assert not {"begin-dispatch", "complete", "fail"} & set(crm.ops())


async def test_a_lost_lease_after_dispatch_still_reports_and_the_crm_decides() -> None:
    crm = FakeCrm(load_fixture("context-publish-social.json"), complete_accepted=False)

    class SlowDispatch(FakePublisher):
        async def dispatch(self, request, prepared):  # noqa: ANN001, ANN201
            crm.heartbeat_states.append("lost")
            await asyncio.sleep(0.05)
            return await super().dispatch(request, prepared)

    publisher = SlowDispatch()
    await _run(crm, claimed("publish_social", PUBLISH_INPUT), make_deps(publisher=publisher))
    assert publisher.dispatches == 1
    assert "complete" in crm.ops()


async def test_shutdown_before_dispatch_abandons_without_reporting() -> None:
    shutdown = asyncio.Event()
    shutdown.set()
    crm = FakeCrm(load_fixture("context-publish-social.json"))
    publisher = FakePublisher()
    await _run(crm, claimed("publish_social", PUBLISH_INPUT), make_deps(publisher=publisher), shutdown)
    assert publisher.dispatches == 0
    assert not {"begin-dispatch", "complete", "fail"} & set(crm.ops())


async def test_preflight_blockers_fail_without_calling_the_provider() -> None:
    context = load_fixture("context-publish-social.json")
    context["platform"] = "instagram"
    context["images"] = []
    crm = FakeCrm(context)
    publisher = FakePublisher()
    await _run(crm, claimed("publish_social", PUBLISH_INPUT), make_deps(publisher=publisher))
    assert publisher.prepared == [] and publisher.dispatches == 0
    assert crm.payload("fail")["outcome"] == "failed"


async def test_ingest_never_calls_begin_dispatch() -> None:
    from tests.test_media_jobs import jpeg_bytes, storage_with

    recorder, storage = storage_with(jpeg_bytes())
    crm = FakeCrm(load_fixture("context-ingest-asset.json"))
    job = claimed("ingest_asset", {"assetId": "a", "quarantinePath": "uploads/a/p.jpg"})
    await _run(crm, job, make_deps(storage=storage))
    assert "begin-dispatch" not in crm.ops()
    assert IngestAssetReady.model_validate(crm.payload("complete")).status == "ready"
    assert recorder.puts


async def test_worker_claims_only_free_slots() -> None:
    settings = make_settings(worker_concurrency=3)
    crm = FakeCrm(load_fixture("context-publish-social.json"))
    gate = asyncio.Event()
    publisher = FakePublisher(prepare_gate=gate)
    crm.claim_batches = [[claimed("publish_social", PUBLISH_INPUT)], []]
    worker = Worker(settings, crm, make_deps(settings=settings, publisher=publisher))  # type: ignore[arg-type]

    assert await worker.run_once() == 1
    await worker.run_once()
    assert [data["limit"] for name, data in crm.calls if name == "claim"] == [3, 2]
    gate.set()
    await worker.drain()
