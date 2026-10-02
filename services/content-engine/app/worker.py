"""The worker loop: claim → per job (context → handler → complete | fail) with heartbeats.

* Bounded concurrency (WORKER_CONCURRENCY): a claim never asks for more jobs than free slots.
* Backoff: an empty claim waits WORKER_IDLE_POLL_SECONDS; CRM errors back off
  exponentially up to WORKER_MAX_BACKOFF_SECONDS.
* Heartbeat every lease/3. ``cancel_requested`` stops the job at its next stage
  boundary; ``lost`` cancels it at once — unless the external effect already started, in
  which case it runs to the end and reports (the CRM discards a stale report).
* SIGTERM/SIGINT: stop claiming; jobs that have not reached begin-dispatch are abandoned
  at their next stage boundary and their lease simply expires (the CRM requeues them);
  jobs past begin-dispatch finish and report. Waits up to WORKER_SHUTDOWN_GRACE_SECONDS.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import signal
from collections.abc import Awaitable, Callable, Coroutine
from typing import Any

from app.config import Settings, get_settings
from app.contracts import ClaimedJob
from app.crm_client import CrmClient, CrmError
from app.jobs import generate_text, media_jobs, publish_social
from app.jobs.deps import Deps, build_deps
from app.jobs.session import JobAbandoned, JobFailure, JobSession
from app.redact import redact

logger = logging.getLogger("app.worker")

Handler = Callable[[JobSession, Any, Deps], Coroutine[Any, Any, dict[str, Any]]]

HANDLERS: dict[str, Handler] = {
    "generate_text": generate_text.handle,
    "generate_image": media_jobs.handle_generate_image,
    "ingest_asset": media_jobs.handle_ingest,
    "publish_social": publish_social.handle,
}

REPORT_ATTEMPTS = 4


async def _report(call: Callable[[], Awaitable[bool]], what: str, job_id: str) -> None:
    """complete/fail must land: retry transient CRM failures while the lease lives."""
    delay = 1.0
    for attempt in range(1, REPORT_ATTEMPTS + 1):
        try:
            accepted = await call()
        except CrmError as exc:
            if not exc.retryable or attempt == REPORT_ATTEMPTS:
                logger.error("Job %s: %s could not be reported: %s", job_id, what, exc)
                return
            await asyncio.sleep(delay)
            delay *= 2
            continue
        if not accepted:
            logger.warning("Job %s: %s refused (lease lost); result discarded by the CRM", job_id, what)
        return


class JobRunner:
    def __init__(self, crm: CrmClient, deps: Deps, *, shutdown: asyncio.Event) -> None:
        self._crm = crm
        self._deps = deps
        self._shutdown = shutdown

    async def run(self, job: ClaimedJob) -> None:
        session = JobSession(
            job, self._crm, lease_seconds=self._deps.settings.lease_seconds, shutdown=self._shutdown
        )
        heartbeat = asyncio.create_task(session.heartbeat_loop())
        try:
            await self._run_guarded(session)
        finally:
            heartbeat.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await heartbeat

    async def _run_guarded(self, session: JobSession) -> None:
        job = session.job
        try:
            result = await self._execute(session)
        except JobAbandoned as exc:
            logger.info("Job %s abandoned: %s", job.job_id, exc)
            return
        except JobFailure as failure:
            logger.info("Job %s failed (%s/%s)", job.job_id, failure.outcome, failure.error_code)
            await self._fail(job, failure)
            return
        except CrmError as exc:
            logger.warning("Job %s: CRM error, letting the lease expire: %s", job.job_id, exc)
            return
        except Exception as exc:  # noqa: BLE001 - last line of defence
            logger.exception("Job %s: unexpected error", job.job_id)
            after_effect = session.dispatch_started and job.kind == "publish_social"
            await self._fail(
                job,
                JobFailure(
                    "uncertain" if after_effect else "retry",
                    "internal_error",
                    f"Unexpected worker error ({type(exc).__name__}).",
                ),
            )
            return
        await _report(lambda: self._crm.complete(job.job_id, job.claim_token, result), "complete", job.job_id)

    async def _fail(self, job: ClaimedJob, failure: JobFailure) -> None:
        async def call() -> bool:
            return await self._crm.fail(
                job.job_id,
                job.claim_token,
                outcome=failure.outcome,
                error_code=failure.error_code,
                message=redact(failure.message),
                provider_request_id=failure.provider_request_id,
            )

        await _report(call, "fail", job.job_id)

    async def _execute(self, session: JobSession) -> dict[str, Any]:
        job = session.job
        context = await self._crm.context(job.job_id, job.claim_token)
        if context.kind != job.kind:
            raise JobFailure(
                "failed", "context_mismatch", f"Context kind {context.kind} for a {job.kind} job."
            )
        session.ensure_can_continue()
        task = asyncio.create_task(HANDLERS[job.kind](session, context, self._deps))
        lost = asyncio.create_task(session.lost.wait())
        try:
            await asyncio.wait({task, lost}, return_when=asyncio.FIRST_COMPLETED)
            if not task.done() and not session.dispatch_started:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
                raise JobAbandoned("lease lost")
            return await task
        finally:
            lost.cancel()


class Worker:
    def __init__(self, settings: Settings, crm: CrmClient, deps: Deps) -> None:
        self._settings = settings
        self._crm = crm
        self._runner_deps = deps
        self.shutdown = asyncio.Event()
        self._runner = JobRunner(crm, deps, shutdown=self.shutdown)
        self._active: set[asyncio.Task[None]] = set()

    async def _sleep(self, seconds: float) -> None:
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self.shutdown.wait(), timeout=seconds)

    async def run_once(self) -> int:
        """Claim up to the free slots and start those jobs. Returns how many were claimed."""
        free = self._settings.worker_concurrency - len(self._active)
        if free <= 0:
            return 0
        jobs = await self._crm.claim(
            self._settings.worker_id, list(self._settings.worker_kinds), free, self._settings.lease_seconds
        )
        for job in jobs:
            task = asyncio.create_task(self._runner.run(job))
            self._active.add(task)
            task.add_done_callback(self._active.discard)
        return len(jobs)

    async def run(self) -> None:
        backoff = self._settings.worker_idle_poll_seconds
        while not self.shutdown.is_set():
            try:
                claimed = await self.run_once()
                backoff = self._settings.worker_idle_poll_seconds
                if claimed:
                    continue
                if len(self._active) >= self._settings.worker_concurrency:
                    await asyncio.wait(self._active, return_when=asyncio.FIRST_COMPLETED)
                    continue
                await self._sleep(self._settings.worker_idle_poll_seconds)
            except CrmError as exc:
                logger.warning("Claim failed, backing off %.1fs: %s", backoff, exc)
                await self._sleep(backoff)
                backoff = min(backoff * 2, self._settings.worker_max_backoff_seconds)
        await self.drain()

    async def drain(self) -> None:
        if not self._active:
            return
        logger.info("Shutting down: waiting for %d job(s)", len(self._active))
        _done, pending = await asyncio.wait(
            self._active, timeout=self._settings.worker_shutdown_grace_seconds
        )
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)


def _install_signal_handlers(worker: Worker) -> None:
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, worker.shutdown.set)
        except (NotImplementedError, RuntimeError):  # Windows event loops
            signal.signal(sig, lambda *_: loop.call_soon_threadsafe(worker.shutdown.set))


async def run_worker(settings: Settings) -> None:
    crm = CrmClient(
        settings.crm_base_url, settings.content_worker_secret, timeout=settings.crm_timeout_seconds
    )
    worker = Worker(settings, crm, build_deps(settings))
    _install_signal_handlers(worker)
    logger.info(
        "Worker %s started (kinds=%s, concurrency=%d, llm_mock=%s, publish_mock=%s)",
        settings.worker_id,
        ",".join(settings.worker_kinds),
        settings.worker_concurrency,
        settings.llm_mock,
        settings.publish_mock,
    )
    try:
        await worker.run()
    finally:
        await crm.aclose()


def main() -> None:
    settings = get_settings()
    logging.basicConfig(level=settings.log_level, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    # httpx logs full request URLs (signed Storage URLs carry tokens) at INFO.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    asyncio.run(run_worker(settings))


if __name__ == "__main__":
    main()
