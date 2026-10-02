# Content Studio: operación

Cómo se despliega, se vigila y se recupera el Content Studio. Contratos: `CONTENT_STUDIO_CONTRACTS.md`. Límites de proveedores pendientes: `CONTENT_STUDIO_PROVIDER_VALIDATION.md`.

## 1. Piezas en ejecución

| Pieza | Dónde | Qué hace |
| --- | --- | --- |
| CRM (Next) | Vercel, como hoy | UI, API de usuario, API interna del worker (`/api/internal/content-worker/v1/*`), Storage y RPCs. |
| Motor `api` | `services/content-engine`, `docker run … api` | `/health` y el intercambio OAuth servidor a servidor. |
| Motor `worker` | Mismo imagen, `docker run … worker` | Reclama jobs del CRM, genera, normaliza imágenes y publica. Proceso persistente con reinicio automático. |
| Cron diario | `/api/cron/jobs` | Solo como red de seguridad: `recover_content_jobs()` una vez por ejecución. Nunca genera ni publica. |

El motor no tiene base de datos ni sesión propia. Si está caído, el CRM sigue funcionando: los jobs quedan `queued` y nadie los pierde.

## 2. Despliegue (orden)

1. Aplicar migraciones `20261007000000` y `20261007010000` (aditivas). Comprobar `npm run db:verify -- content` y `-- snapshots` en local antes de producción.
2. Verificar que existen los buckets `content-quarantine`, `content-library` (privados) y `content-public` (público). Si la migración no los pudo crear, el CRM los crea al primer uso (`ensureContentBuckets`).
3. Configurar en el CRM las variables de `CONTENT_STUDIO_CONTRACTS.md` §5 con `CONTENT_STUDIO_ENABLED=false`. `npm run preflight` debe marcar `content-studio` como `ready` (o `disabled` en `CRM_DISABLED_FEATURES`).
4. Desplegar el motor con el mismo `CONTENT_WORKER_SECRET`, `CRM_BASE_URL` apuntando al CRM, `LLM_MOCK=true` y `PUBLISH_MOCK=true`. Comprobar `/health`.
5. Activar `CONTENT_STUDIO_ENABLED=true` para el equipo piloto. Generar con mocks y verificar el recorrido completo.
6. Pasar a proveedor real de texto/imagen (`LLM_MOCK=false`) con presupuesto limitado.
7. Conectar cuentas sociales de prueba (admin, Settings → Social connections) y activar cada red en `CONTENT_SOCIAL_PLATFORMS` solo tras superar su fila en la matriz de validación.
8. `CONTENT_EMAIL_BRIDGE_ENABLED=true` para export HTML y Automation estática. `CONTENT_EMAIL_DYNAMIC_ENABLED` sigue en `false` hasta EO-4/EO-5.

Registrar en Meta y LinkedIn las URLs de callback `<NEXT_PUBLIC_APP_URL>/api/social/oauth/meta/callback` y `/linkedin/callback`.

## 3. Rollback

Desactivar primero, nunca borrar:

1. `CONTENT_SOCIAL_PLATFORMS=` (vacío) detiene nuevas publicaciones; `begin-dispatch` rechaza las que estuvieran en cola si la cuenta o la revisión dejaron de ser válidas.
2. `CONTENT_STUDIO_ENABLED=false`: el claim devuelve `{jobs: []}` y la API de usuario responde `feature_disabled`. Los jobs que ya estaban en curso pueden terminar.
3. Detener el worker. Ocultar la pestaña por sí solo **no** lo detiene.
4. Resolver los jobs `uncertain` a mano (sección 4).

No borrar tablas, snapshots ni objetos de `content-public`: emails ya enviados siguen apuntando a esas imágenes.

## 4. Estados que requieren a una persona

| Situación | Dónde se ve | Qué hacer |
| --- | --- | --- |
| Publicación `uncertain` | Operations (`socialPublicationsUncertain`), pestaña Publications | Buscar el post en la red. Resolver con "It was published" (id y permalink) o "It was not published". Nunca reintentar a ciegas. |
| Job `uncertain` de generación | Operations (`contentJobsUncertain`) | Revisar consumo en el proveedor si aplica y resolver como fallido; volver a generar si hace falta. |
| Lease vencido (`contentJobsStale`) | Operations | Worker caído o bloqueado: revisar sus logs y reiniciarlo. La recuperación devuelve a la cola lo que no llegó a begin-dispatch. |
| Cuenta `needs_reauth` / desconectada | Operations (`socialAccountsUnhealthy`), Settings | Reconectar como admin. El preflight bloquea mientras tanto. |
| Imagen `rejected` | Biblioteca | El motivo aparece junto a la imagen; subirla de nuevo. |

## 5. Credenciales y rotación

- `CONTENT_WORKER_SECRET` (motor → CRM) y `CONTENT_ENGINE_SECRET` (CRM → motor): valores distintos; rotar cada uno en el CRM y en el motor a la vez (ventana breve de 401/503; los jobs no se pierden).
- `CONTENT_TOKEN_ENCRYPTION_KEY`: mover la clave actual a `CONTENT_TOKEN_ENCRYPTION_KEY_V<versión>`, poner la nueva y subir `CONTENT_TOKEN_ENCRYPTION_KEY_VERSION`. Los tokens antiguos siguen legibles; los nuevos usan la clave nueva. Retirar la antigua solo cuando todas las cuentas se hayan reconectado.
- Secretos de apps Meta/LinkedIn y claves de LLM: solo en el entorno del motor.
- Ninguna de estas variables lleva prefijo `NEXT_PUBLIC_` (lo comprueba `src/lib/supabase/secrets.test.ts`).

## 6. Límites conocidos

- La API v2 de EmailOctopus no permite crear campañas HTML ni leer el HTML de Automations. El export queda registrado como exportación, no como envío.
- Un email del Studio lleva como máximo una imagen principal.
- Las versiones Meta `v23.0` y LinkedIn `202506` vienen de WRCC y deben revalidarse antes de producción.
- La generación desde catálogo, el calendario, la analítica y la bandeja de comentarios/DM no forman parte de esta entrega.
- Exportar o crear un email copia su imagen a `content-public` en ese momento (el HTML necesita una URL pública estable), antes de que la campaña se apruebe. La URL no es adivinable ni listable, pero no debe usarse una imagen confidencial en un email.
- El checksum que informa el worker al terminar la ingesta no se vuelve a calcular sobre los bytes guardados. La ruta de destino la fija el CRM y solo el titular del lease recibe URLs de subida.
- La biblioteca muestra solo imágenes activas; las archivadas siguen en Storage y en las revisiones que las usan.
- Antes de generar contenido real, un admin debe completar el perfil de marca (Settings → Brand profile): sin `allowedLinkOrigins`, todo enlace generado queda bloqueado hasta que una persona lo edite.
