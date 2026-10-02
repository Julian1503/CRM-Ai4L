"""Engine HTTP API — called only by the CRM server, never by a browser.

* ``GET /health`` — liveness and mode flags; no secrets, no configuration values.
* ``POST /v1/oauth/{provider}/authorize-url`` ``{state, redirectUri, options}`` → ``{url}``
* ``POST /v1/oauth/{provider}/exchange`` ``{code, redirectUri, options}`` → ``{accounts}``

The two OAuth routes are authenticated with the same HMAC scheme as the worker protocol
but a separate secret, CONTENT_ENGINE_SECRET (CRM → engine; the worker's
CONTENT_WORKER_SECRET signs engine → CRM), 300 s tolerance, verified over the exact raw
body, which is capped at 256 KiB before it is read. OAuth app
secrets live only in this service's environment. Responses from ``exchange`` carry
tokens for the CRM server to encrypt; they are never logged.

Run: ``uvicorn app.main:create_app --factory``.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app import signing
from app.config import MIN_WORKER_SECRET_LENGTH, Settings, get_settings
from app.contracts import WORKER_PROTOCOL_VERSION, SocialProvider
from app.redact import redact
from app.social.oauth import get_oauth_provider
from app.social.oauth.base import OAuthError, OAuthNotConfigured, validate_redirect_uri

logger = logging.getLogger(__name__)

_PROVIDERS: tuple[SocialProvider, ...] = ("meta", "linkedin", "mock")


class _Body(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    redirect_uri: str = Field(alias="redirectUri", min_length=1, max_length=2000)
    options: dict[str, Any] = Field(default_factory=dict)


class AuthorizeUrlBody(_Body):
    state: str = Field(min_length=16, max_length=512)


class ExchangeBody(_Body):
    code: str = Field(min_length=1, max_length=4096)


MAX_BODY_BYTES = 256 * 1024


async def _read_capped_body(request: Request) -> bytes:
    """The raw body, refused (413) above MAX_BODY_BYTES before it is buffered or verified."""
    declared = request.headers.get("content-length")
    if declared is not None and (not declared.isdigit() or int(declared) > MAX_BODY_BYTES):
        raise HTTPException(status_code=413, detail="Request body too large.")
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_BODY_BYTES:
            raise HTTPException(status_code=413, detail="Request body too large.")
        chunks.append(chunk)
    return b"".join(chunks)


async def _authenticated_body(request: Request, settings: Settings) -> bytes:
    body = await _read_capped_body(request)
    ok = signing.verify(
        settings.content_engine_secret.strip(),
        method=request.method,
        path=request.url.path,
        body=body,
        timestamp_header=request.headers.get(signing.TIMESTAMP_HEADER),
        signature_header=request.headers.get(signing.SIGNATURE_HEADER),
    )
    if not ok:
        raise HTTPException(status_code=401, detail="Invalid signature.")
    return body


def _provider(name: str) -> SocialProvider:
    if name not in _PROVIDERS:
        raise HTTPException(status_code=404, detail="Unknown provider.")
    return name  # type: ignore[return-value]


def _parse(model: type[BaseModel], body: bytes) -> Any:
    try:
        return model.model_validate_json(body)
    except ValidationError:
        raise HTTPException(status_code=422, detail="Invalid request body.") from None


def create_app(settings: Settings | None = None) -> FastAPI:
    config = settings or get_settings()
    if len(config.content_engine_secret.strip()) < MIN_WORKER_SECRET_LENGTH:
        raise ValueError("CONTENT_ENGINE_SECRET is required for the api role (at least 32 characters).")
    app = FastAPI(title="AI4L content engine", docs_url=None, redoc_url=None, openapi_url=None)
    allow_local_http = config.app_env != "production"

    @app.exception_handler(HTTPException)
    async def _http_error(_request: Request, exc: HTTPException) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"error": str(exc.detail)})

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "protocol": WORKER_PROTOCOL_VERSION,
            "llmMock": config.llm_mock,
            "publishMock": config.publish_mock,
        }

    @app.post("/v1/oauth/{provider}/authorize-url")
    async def authorize_url(provider: str, request: Request) -> dict[str, str]:
        name = _provider(provider)
        body: AuthorizeUrlBody = _parse(AuthorizeUrlBody, await _authenticated_body(request, config))
        try:
            redirect = validate_redirect_uri(body.redirect_uri, allow_local_http=allow_local_http)
            url = get_oauth_provider(name, config).authorize_url(
                state=body.state, redirect_uri=redirect, options=body.options
            )
        except OAuthNotConfigured as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from None
        except OAuthError as exc:
            raise HTTPException(status_code=400, detail=redact(exc)) from None
        return {"url": url}

    @app.post("/v1/oauth/{provider}/exchange")
    async def exchange(provider: str, request: Request) -> dict[str, Any]:
        name = _provider(provider)
        body: ExchangeBody = _parse(ExchangeBody, await _authenticated_body(request, config))
        try:
            redirect = validate_redirect_uri(body.redirect_uri, allow_local_http=allow_local_http)
            accounts = await get_oauth_provider(name, config).exchange(
                body.code, redirect_uri=redirect, options=body.options
            )
        except OAuthNotConfigured as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from None
        except OAuthError as exc:
            logger.info("OAuth exchange for %s refused", name)
            raise HTTPException(status_code=400, detail=redact(exc)) from None
        return {"accounts": [account.to_wire() for account in accounts]}

    return app
