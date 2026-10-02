# Content Studio: contratos y decisiones de fase 0

Complemento operativo de `CONTENT_STUDIO_SOCIAL_EMAIL_IMPLEMENTATION_PLAN.md`. Lo que aquí se fija es el contrato con el que construyen todos los frentes. Cambiarlo exige actualizar este documento, `src/lib/content-studio/types.ts`, `services/content-engine/app/contracts.py` y los fixtures de `shared/content-contracts/`.

## 1. Decisiones cerradas

| Tema | Decisión |
| --- | --- |
| Marca / tenancy | Solo AI4L. `content_brand_profiles` con una fila `ai4l`. Sin workspaces. `organisations` no es tenant. |
| Motor | Python extraído de WRCC en `services/content-engine/` (copia versionada con procedencia; sin import en runtime de WRCC). |
| Campañas legacy | Conservan su comportamiento auditado: una campaña fallida puede corregirse y reintentarse para los destinatarios restantes. Las campañas del Studio no pueden cambiar de contenido, plantilla ni automation: contenido nuevo = campaña nueva. |
| Hosting del motor | Agnóstico: Dockerfile genérico con dos entrypoints (`api`, `worker`), healthcheck y reinicio a cargo de la plataforma. |
| Interacción social (comentarios, DM) | Fuera de alcance. |
| Catálogo | Fuera de alcance de esta entrega (sección 16 del plan). La generación parte de brief + hechos aprobados. |
| Modo email | 1) HTML exportable siempre disponible. 2) Automation estática versionada registrada en el CRM. 3) Automation dinámica por campos: implementada detrás de flag y **desactivada** hasta superar la matriz de `CONTENT_STUDIO_PROVIDER_VALIDATION.md`. |
| Permisos | Operador: crear, generar, editar, revisar, aprobar, publicar y crear email draft. Admin: además conectar/desconectar cuentas y editar el perfil de marca. |
| Pruebas con proveedores reales | No se ejecutan sin autorización explícita. CI y E2E usan mocks (`LLM_MOCK`, `PUBLISH_MOCK`). |

## 2. Estados

- **Job:** `queued → running → succeeded | failed | cancelled | uncertain`; `running → queued` solo por `retry` antes de begin-dispatch o por lease expirado antes de begin-dispatch.
- **Publicación:** `queued → dispatching → published | failed | uncertain`; `queued → cancelled`.
- **Revisión:** inmutable. Estado de revisión derivado de su última review (`pending` si no hay). Solo la revisión vigente de una variante puede revisarse o publicarse.
- **Asset:** `pending → ready | rejected`.

## 3. Protocolo worker v1

`POST /api/internal/content-worker/v1/{claim,heartbeat,context,checkpoint,begin-dispatch,complete,fail}`.

- Firma HMAC-SHA256 con `CONTENT_WORKER_SECRET` sobre `${ts}.${METHOD}.${path}.${body}`, cabeceras `X-Content-Worker-Timestamp` y `X-Content-Worker-Signature: v1=<hex>`, tolerancia 300 s. Secreto distinto de `CRON_SECRET` y de la service role. Body máximo 512 KiB, comprobado antes de leerlo entero. Las llamadas en sentido contrario (CRM → motor) usan el mismo esquema con `CONTENT_ENGINE_SECRET`.
- Una revisión generada con una violación `blocked:` (p. ej. un enlace fuera de `allowedLinkOrigins`) no puede aprobarse hasta que una persona la edite.
- Rutas en allowlist exacta (`INTERNAL_WORKER_PATHS` en `src/lib/auth/routes.ts`); cada handler verifica la firma.
- Todas las mutaciones llevan `jobId` + `claimToken`; SQL rechaza al worker con lease viejo (`accepted: false` / `decision: 'lost'`).
- Secuencia: `claim → context → [checkpoint…] → begin-dispatch → (llamada externa) → complete | fail`. `heartbeat` cada ≤ 1/3 del lease; `cancel_requested` detiene antes de la siguiente etapa, `lost` detiene de inmediato.
- `ingest_asset` no requiere begin-dispatch. `generate_text`, `generate_image` y `publish_social` sí.
- `fail.outcome`: `retry` (sin efecto externo), `failed` (definitivo), `uncertain` (el efecto pudo ocurrir). Tras begin-dispatch un `retry` de `publish_social` se convierte en `uncertain` en SQL.
- La llamada con efecto público nunca se reintenta automáticamente. Un 5xx, timeout o respuesta no JSON en la llamada pública → `uncertain`.
- El token social viaja solo en la respuesta de `context` de un job `publish_social` autorizado; nunca en `input`, `checkpoint`, `result`, logs ni errores.

Tipos exactos: `src/lib/content-studio/types.ts` (sección "worker protocol v1"). Fixtures: `shared/content-contracts/fixtures/`.

## 4. Storage

| Bucket | Visibilidad | Escribe | Paths |
| --- | --- | --- | --- |
| `content-quarantine` | privado | navegador mediante signed upload URL emitida por el CRM | `uploads/<assetId>/<nombre-saneado>` |
| `content-library` | privado | worker mediante signed upload URL | `library/<assetId>/original.<ext>`, `library/<assetId>/social.jpg`, `library/<assetId>/email.<ext>`; generadas: `generated/<jobId>/<n>/…` |
| `content-public` | público por URL, sin listado | servidor CRM (service role) | `p/<publishedAssetId>/<checksum>.<ext>` inmutable |

Ninguna política de `storage.objects` para `anon`/`authenticated`. Paths nunca contienen datos de contactos. Emails y proveedores sociales solo reciben URLs de `content-public`.

## 5. Flags y variables

CRM (`.env.local.example`):

| Variable | Uso |
| --- | --- |
| `CONTENT_STUDIO_ENABLED` | `true` monta la pestaña y acepta nuevas solicitudes. |
| `CONTENT_SOCIAL_PLATFORMS` | Lista de redes con publicación habilitada (`facebook,instagram,linkedin`). Vacía = ninguna. |
| `CONTENT_EMAIL_BRIDGE_ENABLED` | Habilita crear email draft / export desde el Studio. |
| `CONTENT_EMAIL_DYNAMIC_ENABLED` | Automation dinámica por campos. `false` hasta validar proveedor. |
| `CONTENT_WORKER_SECRET` | Firma del protocolo worker, motor → CRM (≥ 32 caracteres). |
| `CONTENT_ENGINE_SECRET` | Firma de las llamadas CRM → motor (intercambio OAuth). Distinto del anterior. |
| `CONTENT_TOKEN_ENCRYPTION_KEY` | 32 bytes base64 para AES-256-GCM de tokens sociales. |
| `CONTENT_TOKEN_ENCRYPTION_KEY_VERSION` | Entero; rotación. |
| `CONTENT_ENGINE_URL` | URL del API del motor (intercambio OAuth servidor a servidor). |
| `META_APP_ID`, `LINKEDIN_CLIENT_ID` | Identificadores públicos de apps OAuth (los secretos viven en el motor). |

Motor (`services/content-engine/.env.example`): `CRM_BASE_URL`, `CONTENT_WORKER_SECRET`, `LLM_MOCK`, `LLM_PROVIDER`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, modelos, `PUBLISH_MOCK`, `META_APP_ID`, `META_APP_SECRET`, `META_GRAPH_VERSION`, `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_API_VERSION`, límites de concurrencia/lease.

## 6. Propiedad de archivos por frente

| Frente | Propietario único |
| --- | --- |
| Coordinador | `supabase/migrations/2026100700*`, `supabase/tests/verify_2026100700*`, `scripts/db-verify.mjs`, `src/lib/db/types.ts`, `src/lib/content-studio/types.ts`, `src/lib/content-studio/workerAuth.ts`, `src/lib/auth/routes.ts`, `src/proxy.ts`, `src/components/Sidebar.tsx`, `src/app/page.tsx`, `.github/workflows/ci.yml`, `playwright.config.ts`, `.env.local.example`, `scripts/lib/readiness.mjs`, este documento. |
| Agente 1 | `services/content-engine/**`, `shared/content-contracts/**`; en Tanda C además `src/lib/social/**` (salvo `credentials.ts`), `src/app/api/social/**`, `src/components/settings/SocialConnectionsSettings.*`. |
| Agente 2 | `src/components/content-studio/**`; en Tanda C además `src/lib/marketing/**` y `src/components/marketing/**`, `src/app/api/campaigns/**`, `src/app/api/templates/**`, `src/app/api/integrations/emailoctopus/**`, `src/lib/content-studio/{toEmailCampaign,emailRenderer}.ts`, `src/app/api/content-studio/variants/[id]/{email-draft,email-export}/**`. |
| Agente 3 | `src/lib/content-studio/**` (salvo `types.ts`, `workerAuth.ts` y los dos archivos de email), `src/app/api/content-studio/**` (salvo email), `src/app/api/internal/content-worker/**`, `src/lib/crypto/**`, `src/lib/social/credentials.ts`, `src/lib/operations/**`, `src/components/operations/**`; en Tanda C pruebas de integración/E2E. |

Quien necesite cambiar un archivo ajeno lo pide al propietario (vía coordinador); nunca reemplaza un archivo completo de otro frente.
