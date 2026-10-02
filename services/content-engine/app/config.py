"""Engine configuration: every environment variable, validated at startup.

Mock-first: LLM_MOCK and PUBLISH_MOCK default to true, so the engine boots and runs the
whole job pipeline without any provider credential. Live mode fails fast when a key it
needs is missing. Nothing here knows about a database, sessions or a brand — the CRM
owns those and sends what a job needs in its context.
"""

from __future__ import annotations

import os
import socket
from functools import lru_cache
from typing import Annotated, Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

from app.contracts import JobKind

# "development" is accepted as a synonym of "local" (the CRM's NODE_ENV vocabulary).
AppEnv = Literal["local", "development", "staging", "production"]
ReasoningEffort = Literal["", "minimal", "low", "medium", "high"]
ImageQuality = Literal["low", "medium", "high", "auto"]

MIN_WORKER_SECRET_LENGTH = 32
ALL_KINDS: tuple[JobKind, ...] = ("generate_text", "generate_image", "ingest_asset", "publish_social")


def _default_worker_id() -> str:
    return f"{socket.gethostname()}-{os.getpid()}"[:120]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore", case_sensitive=False
    )

    # ── Core ──
    app_env: AppEnv = "local"
    log_level: str = "INFO"

    # ── CRM bridge (worker protocol v1) ──
    crm_base_url: str = "http://localhost:3000"
    content_worker_secret: str = Field(default="", repr=False)
    # Signs CRM → engine calls (the OAuth API). Deliberately separate from
    # CONTENT_WORKER_SECRET (engine → CRM), so one leaked key cannot drive both directions.
    # Required by the api role; the worker role does not read it.
    content_engine_secret: str = Field(default="", repr=False)
    worker_id: str = Field(default_factory=_default_worker_id)
    worker_kinds: Annotated[list[JobKind], NoDecode] = Field(default_factory=lambda: list(ALL_KINDS))
    worker_concurrency: int = Field(default=4, ge=1, le=20)
    lease_seconds: int = Field(default=120, ge=30, le=900)
    worker_idle_poll_seconds: float = Field(default=2.0, gt=0)
    worker_max_backoff_seconds: float = Field(default=30.0, gt=0)
    worker_shutdown_grace_seconds: float = Field(default=60.0, ge=0)
    crm_timeout_seconds: float = Field(default=20.0, gt=0)
    # Signed Storage URLs point at Supabase. Local Supabase serves plain http on
    # 127.0.0.1, so http is allowed only when explicitly enabled.
    storage_allow_http: bool = False
    storage_timeout_seconds: float = Field(default=60.0, gt=0)

    # ── LLM (mock-first) ──
    llm_mock: bool = True
    llm_provider: Literal["gemini", "openai"] = "openai"
    gemini_api_key: str = Field(default="", repr=False)
    gemini_model: str = "gemini-2.5-flash"
    openai_api_key: str = Field(default="", repr=False)
    openai_model: str = "gpt-5-mini"
    openai_reasoning_effort: ReasoningEffort = "low"
    llm_timeout_seconds: float = Field(default=60.0, gt=0)
    llm_max_attempts: int = Field(default=2, ge=1, le=3)
    llm_max_concurrency: int = Field(default=6, ge=1, le=20)
    generation_deadline_seconds: float = Field(default=240.0, gt=0)

    # ── Images ──
    image_model: str = "gpt-image-1"
    image_size: str = "1024x1024"
    image_timeout_seconds: float = Field(default=180.0, gt=0)

    # ── Media ──
    media_max_source_bytes: int = Field(default=15 * 1024 * 1024, gt=0)

    # ── Reference URL fetch (SSRF-guarded) ──
    reference_fetch_timeout_seconds: float = Field(default=8.0, gt=0)
    reference_fetch_max_bytes: int = Field(default=1_000_000, gt=0)
    reference_fetch_max_chars: int = Field(default=4000, gt=0)
    reference_fetch_max_redirects: int = Field(default=3, ge=0, le=5)
    reference_user_agent: str = "AI4L-ContentEngine/0.1"

    # ── Publishing (mock-first) ──
    publish_mock: bool = True
    publish_timeout_seconds: float = Field(default=30.0, gt=0)
    publish_max_attempts: int = Field(default=3, ge=1, le=5)
    publish_retry_base_delay_seconds: float = Field(default=0.5, ge=0)
    instagram_container_poll_attempts: int = Field(default=12, ge=1)
    instagram_container_poll_delay_seconds: float = Field(default=2.0, ge=0)

    # ── Meta (Facebook + Instagram). Versions must be revalidated before going live. ──
    meta_app_id: str = ""
    meta_app_secret: str = Field(default="", repr=False)
    meta_graph_version: str = "v23.0"
    meta_login_config_id: str = ""

    # ── LinkedIn ──
    linkedin_client_id: str = ""
    linkedin_client_secret: str = Field(default="", repr=False)
    linkedin_api_version: str = "202506"

    @field_validator("worker_kinds", mode="before")
    @classmethod
    def _split_kinds(cls, value: object) -> object:
        if isinstance(value, str):
            return [part.strip() for part in value.split(",") if part.strip()]
        return value

    @field_validator("worker_id", mode="after")
    @classmethod
    def _default_blank_worker_id(cls, value: str) -> str:
        return value.strip()[:120] or _default_worker_id()

    @field_validator("crm_base_url", mode="after")
    @classmethod
    def _strip_slash(cls, value: str) -> str:
        return value.rstrip("/")

    @property
    def graph_base_url(self) -> str:
        return f"https://graph.facebook.com/{self.meta_graph_version}"

    @property
    def live_model_name(self) -> str:
        return self.openai_model if self.llm_provider == "openai" else self.gemini_model

    @model_validator(mode="after")
    def _validate(self) -> Settings:
        problems: list[str] = []
        if len(self.content_worker_secret.strip()) < MIN_WORKER_SECRET_LENGTH:
            problems.append(
                f"CONTENT_WORKER_SECRET (required, at least {MIN_WORKER_SECRET_LENGTH} characters)"
            )
        if not self.worker_kinds:
            problems.append("WORKER_KINDS (at least one job kind)")
        if not self.llm_mock:
            if self.llm_provider == "openai" and not self.openai_api_key:
                problems.append("OPENAI_API_KEY (required when LLM_MOCK=false and LLM_PROVIDER=openai)")
            if self.llm_provider == "gemini" and not self.gemini_api_key:
                problems.append("GEMINI_API_KEY (required when LLM_MOCK=false and LLM_PROVIDER=gemini)")
        if self.app_env == "production" and self.storage_allow_http:
            problems.append("STORAGE_ALLOW_HTTP (not allowed in production)")
        if self.app_env == "production" and not self.crm_base_url.startswith("https://"):
            problems.append("CRM_BASE_URL (must be https in production)")
        engine_secret = self.content_engine_secret.strip()
        if engine_secret and len(engine_secret) < MIN_WORKER_SECRET_LENGTH:
            problems.append(f"CONTENT_ENGINE_SECRET (at least {MIN_WORKER_SECRET_LENGTH} characters)")
        if engine_secret and engine_secret == self.content_worker_secret.strip():
            problems.append("CONTENT_ENGINE_SECRET (must differ from CONTENT_WORKER_SECRET)")
        if problems:
            raise ValueError("Invalid configuration:\n  - " + "\n  - ".join(problems))
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
