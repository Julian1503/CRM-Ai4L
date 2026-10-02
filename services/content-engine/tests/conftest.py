"""Shared test helpers. No network: every edge is an httpx.MockTransport or a fake."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from app.config import Settings

FIXTURES = Path(__file__).resolve().parents[3] / "shared" / "content-contracts" / "fixtures"
TEST_SECRET = "test-worker-secret-0123456789abcdef-not-real"
TEST_ENGINE_SECRET = "test-engine-secret-0123456789abcdef-not-real"


def load_fixture(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def make_settings(**overrides: Any) -> Settings:
    defaults: dict[str, Any] = {
        "_env_file": None,
        "content_worker_secret": TEST_SECRET,
        "content_engine_secret": TEST_ENGINE_SECRET,
        "crm_base_url": "https://crm.test",
        "worker_id": "worker-test",
        "publish_retry_base_delay_seconds": 0.0,
        "instagram_container_poll_delay_seconds": 0.0,
        "lease_seconds": 30,
    }
    defaults.update(overrides)
    return Settings(**defaults)


@pytest.fixture
def settings() -> Settings:
    return make_settings()
