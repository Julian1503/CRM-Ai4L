"""One claimed job's lease: heartbeats, stage guards, checkpoint and begin-dispatch.

Handlers call ``ensure_can_continue`` at every stage boundary. That is where a
``cancel_requested`` heartbeat, a lost lease or a worker shutdown takes effect — and
only *before* begin-dispatch. Once the external effect has started, the handler runs to
completion and reports what happened; the SQL side decides whether that report still
counts (a stale lease gets ``accepted: false``).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from app.contracts import ClaimedJob, FailOutcome
from app.crm_client import CrmClient, CrmError

logger = logging.getLogger(__name__)


class JobFailure(Exception):
    """Report this job through ``fail`` with the given outcome."""

    def __init__(
        self,
        outcome: FailOutcome,
        error_code: str,
        message: str,
        *,
        provider_request_id: str | None = None,
    ) -> None:
        super().__init__(message)
        self.outcome: FailOutcome = outcome
        self.error_code = error_code
        self.message = message
        self.provider_request_id = provider_request_id


class JobAbandoned(Exception):
    """Stop without reporting: the lease is gone, dispatch was refused, or shutdown.

    Before begin-dispatch an abandoned job simply lets its lease expire and the CRM
    recovery puts it back in the queue.
    """


class JobSession:
    def __init__(
        self,
        job: ClaimedJob,
        crm: CrmClient,
        *,
        lease_seconds: int,
        shutdown: asyncio.Event | None = None,
    ) -> None:
        self.job = job
        self._crm = crm
        self._lease_seconds = lease_seconds
        self._shutdown = shutdown or asyncio.Event()
        self.lost = asyncio.Event()
        self.cancel_requested = False
        self.dispatch_started = False

    @property
    def job_id(self) -> str:
        return self.job.job_id

    @property
    def token(self) -> str:
        return self.job.claim_token

    @property
    def heartbeat_interval(self) -> float:
        return max(1.0, self._lease_seconds / 3)

    async def heartbeat_loop(self) -> None:
        """Extend the lease every lease/3 until lost or cancelled by the runner."""
        while not self.lost.is_set():
            await asyncio.sleep(self.heartbeat_interval)
            try:
                state = await self._crm.heartbeat(self.job_id, self.token)
            except CrmError as exc:
                logger.warning("Heartbeat for job %s failed: %s", self.job_id, exc)
                continue
            if state == "lost":
                logger.warning("Job %s lease lost", self.job_id)
                self.lost.set()
                return
            if state == "cancel_requested" and not self.cancel_requested:
                logger.info("Job %s cancellation requested", self.job_id)
                self.cancel_requested = True

    def ensure_can_continue(self) -> None:
        """Stage guard. Only meaningful before the external effect starts."""
        if self.dispatch_started:
            return
        if self.lost.is_set():
            raise JobAbandoned("lease lost")
        if self.cancel_requested:
            # 'retry' on a cancelled job is closed as 'cancelled' by fail_content_job.
            raise JobFailure("retry", "cancelled", "Cancelled by an operator before dispatch.")
        if self._shutdown.is_set():
            raise JobAbandoned("worker shutting down")

    async def checkpoint(self, data: dict[str, Any]) -> None:
        if not await self._crm.checkpoint(self.job_id, self.token, data):
            self.lost.set()
            raise JobAbandoned("checkpoint refused: lease lost")

    async def begin_dispatch(self) -> None:
        """Record that the external effect starts now. Anything but 'go' stops the job."""
        self.ensure_can_continue()
        decision = await self._crm.begin_dispatch(self.job_id, self.token)
        if decision == "go":
            self.dispatch_started = True
            return
        if decision == "lost":
            self.lost.set()
        # 'refused': the CRM already closed the job and publication; never call the provider.
        raise JobAbandoned(f"begin-dispatch {decision}")
