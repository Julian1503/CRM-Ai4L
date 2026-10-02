# AI4L content engine

Python service that holds the parts of Content Studio that are cheaper to keep than to
rewrite: text and image generation, image ingest and renditions, OAuth code exchange and
the Facebook / Instagram / LinkedIn publishers. The CRM (Next.js + Supabase) owns
identity, data, approvals, the job queue and Storage. This service holds no database and
no Storage key; it only talks to the CRM's signed internal endpoints and to providers.

Contracts: `docs/CONTENT_STUDIO_CONTRACTS.md`, `src/lib/content-studio/types.ts`
(worker protocol v1), mirrored in `app/contracts.py` and pinned by
`shared/content-contracts/fixtures/`.

## Run locally

```bash
py -3.14 -m venv .venv
.venv/Scripts/python -m pip install -e ".[dev]"     # POSIX: .venv/bin/python
cp .env.example .env                                  # set CONTENT_WORKER_SECRET and CONTENT_ENGINE_SECRET
.venv/Scripts/python -m pytest
.venv/Scripts/ruff check app tests && .venv/Scripts/mypy app

# API (health + OAuth exchange)
.venv/Scripts/uvicorn app.main:create_app --factory --port 8000
# Worker
.venv/Scripts/python -m app.worker
```

Docker (one image, two roles): `docker build -t content-engine .` then
`docker run --env-file .env content-engine api` or `... content-engine worker`.
Python 3.14 is used in the image because it is what the service was developed and tested
with; the code itself needs ≥ 3.12. The image runs as a non-root user and defines a
`HEALTHCHECK` (HTTP `/health` for `api`; PID-1 check for `worker`).

Mock modes are on by default (`LLM_MOCK=true`, `PUBLISH_MOCK=true`). Real providers are
never called in CI or tests.

## Layout

| Path | Role |
| --- | --- |
| `app/contracts.py` | Pydantic mirror of the worker protocol v1 (camelCase on the wire). |
| `app/config.py` | Every environment variable, validated at startup. |
| `app/signing.py`, `app/crm_client.py` | HMAC signing and the CRM client (`claim`, `heartbeat`, `context`, `checkpoint`, `begin-dispatch`, `complete`, `fail`). |
| `app/worker.py`, `app/jobs/*` | Worker loop, lease session and one handler per job kind. |
| `app/generation/*` | Brand-parameterised prompts, profiles/validation, LLM and image clients, partial fan-out, SSRF-guarded reference fetch. |
| `app/media/*` | Ingest normalisation, renditions, signed-URL storage I/O. |
| `app/social/*` | Rules, Meta Graph transport, publishers (prepare/dispatch), OAuth providers. |
| `app/main.py` | `GET /health`, `POST /v1/oauth/{provider}/authorize-url`, `POST /v1/oauth/{provider}/exchange` (HMAC with `CONTENT_ENGINE_SECRET`, body ≤ 256 KiB). |

## Behaviour worth knowing

* **Job sequence.** `claim → context → [checkpoint] → begin-dispatch → provider → complete | fail`.
  `ingest_asset` skips begin-dispatch. Heartbeat every lease/3; `cancel_requested` stops
  the job at its next stage, `lost` stops it at once — except after begin-dispatch, when
  the job runs to the end and reports (the CRM discards a stale report).
* **Shutdown.** SIGTERM stops claiming. Jobs before begin-dispatch are abandoned and their
  lease expires (the CRM requeues them); jobs past it finish.
* **Publishing never posts twice.** Every publisher is split into `prepare` (unpublished
  Facebook photos, Instagram containers, LinkedIn image URNs — retried, checkpointed,
  resumable) and `dispatch` (the one public call, never retried). On dispatch, a structured
  4xx is `failed`; a 5xx, timeout, non-JSON body or success without an id is `uncertain`.
  This fixes the WRCC Facebook 0/1-image path, which retried the public call.
* **Generation fail rule.** Channels fail independently; partial results complete with
  `failures`. If every channel fails: all `transient` → `retry`; any `invalid`/`config` →
  `failed`. Generation never reports `uncertain` (no public effect).
* **Reference URLs.** https only, default port, every resolved address must be public
  (checked on each of ≤ 3 manual redirects), connection pinned to the checked IP (Host +
  SNI), streamed byte cap, text content types only, one deadline. The excerpt is fenced as
  untrusted data in the prompt.
* **Storage uploads.** Supabase signed upload URLs are used like supabase-js
  `uploadToSignedUrl` with a raw body: `PUT {signedUrl}` (token in the query) with
  `content-type`, `cache-control` and `x-upsert: true`. Upload targets are matched by stem
  (`original`, `social`, `email`) and extension, so the CRM can offer both `.jpg` and
  `.png` for files whose format depends on transparency.
* **Two secrets, one per direction.** `CONTENT_WORKER_SECRET` signs engine → CRM (worker
  protocol); `CONTENT_ENGINE_SECRET` signs CRM → engine (OAuth API). They must differ; the
  api role refuses to start without the latter. In production `CRM_BASE_URL` must be https.
* **Links.** Any URL in generated text or email fields whose origin is not in the brand's
  `allowedLinkOrigins` yields a violation starting with `blocked:`; the CRM refuses to
  approve such a revision until a person edits it. Reference text is fenced with `<`/`>`
  escaped, so no spelling of the closing tag can break out.
* **Mock accounts** use `mock:`-prefixed external ids, so they can never collide with a real row.
* **Secrets.** Tokens are never logged, checkpointed or returned in results/errors;
  `app/redact.py` masks `access_token`, `client_secret`, `fb_exchange_token`, `code`,
  `token`, `refresh_token` and bearer values; URLs are logged without query strings.

## Revalidate before going live

* `META_GRAPH_VERSION=v23.0` and the Meta scopes (`app/social/oauth/meta.py`, now
  including `business_management` for Business-Portfolio-owned Pages).
* `LINKEDIN_API_VERSION=202506` (LinkedIn retires versions) and the `multiImage` payload.
* Default models `gpt-5-mini`, `gemini-2.5-flash`, `gpt-image-1`.

## Provenance

Extracted from WRCC Content Studio (`C:/Projects/wrcc-content-studio`, commit
`e4f5ccb8682fbbda951cc3edd625224565dda3e4`, 2026-09-21) as a versioned copy; nothing is
imported from that repository at runtime.

| Engine file | WRCC source (`backend/…`) | Change |
| --- | --- | --- |
| `app/media/ingest.py` | `app/content/ingest.py` | Near-verbatim; docstring, DecompressionBomb guard. |
| `app/media/publish_formats.py` | `app/publishing/media.py` | `to_jpeg`, Instagram checks; signed URLs dropped. |
| `app/generation/llm.py`, `images.py` | `app/llm/client.py`, `app/llm/images.py` | Error classes, usage/request ids, brand-neutral mock. |
| `app/generation/prompts.py`, `profiles.py`, `orchestrate.py` | `app/agents/content_generator.py`, `validation.py`, `app/content/service.py` | Brand profile instead of WRCC copy/courses; email channel; partial results. |
| `app/generation/reference.py` | `app/content/service.py::fetch_reference_excerpt` | Rewritten with SSRF limits. |
| `app/social/meta_graph.py` | `app/publishing/meta_graph.py` | `structured` flag, wider redaction. |
| `app/social/publishers/*` | `app/publishing/publishers/*` | Split into prepare/dispatch; explicit LinkedIn author kind. |
| `app/social/oauth/*` | `app/publishing/oauth/*` | Redirect URI per call; state owned by the CRM; no member fallback. |
| `app/social/rules.py` | `app/publishing/rules.py` | Pure parts only (compose, limits, dispatch blockers). |
| `tests/test_media_ingest.py` | `tests/test_media_ingest.py` | Ported. Other tests rewritten for the new seams. |

Not copied: WRCC auth, SQLAlchemy models/repositories, Alembic, scraper/courses, branding,
signed media URLs, token encryption (the CRM encrypts), workflow state machine.

**License:** no LICENSE file exists in the WRCC repository. Reuse of this code in AI4L
is pending confirmation from the owner.
