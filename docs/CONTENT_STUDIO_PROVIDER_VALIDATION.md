# Content Studio: validación de proveedores

Registro de lo que **no** puede demostrarse con mocks. Ninguna prueba de esta página se ejecuta sin autorización explícita, cuenta de prueba y destinatarios controlados. Mientras una fila esté pendiente, la capacidad asociada permanece desactivada por flag.

Estado inicial (30-09-2026): todas pendientes. El código se entregó y probó solo con `LLM_MOCK=true`, `PUBLISH_MOCK=true` y el proveedor de email simulado.

## 1. EmailOctopus (gobierna `CONTENT_EMAIL_DYNAMIC_ENABLED`)

| # | Prueba | Criterio de aceptación | Estado | Evidencia |
| --- | --- | --- | --- | --- |
| EO-1 | Campos en cuerpo | Valores con acentos, `&`, `<`, comillas y saltos de línea llegan escapados y sin truncar hasta los límites del contrato `studio-newsletter-v1`. | Pendiente | |
| EO-2 | Imagen dinámica | Un campo en `src` y otro en `alt` se conservan tras guardar en el editor y en el render recibido. | Pendiente | |
| EO-3 | Asunto | Se documenta si el asunto de la Automation puede depender de un campo. Si no, el asunto es estático por versión de Automation. | Pendiente | |
| EO-4 | Momento de lectura | Se determina cuándo se materializan los campos (entrada, paso de email, envío). | Pendiente | |
| EO-5 | Concurrencia | Dos campañas, mismo contacto, contenido distinto y esperas deliberadas: cada email recibido corresponde a su campaña. | Pendiente | |
| EO-6 | Repetición | Comportamiento con "Allow contacts to repeat", contacto en ejecución y reintentos. | Pendiente | |
| EO-7 | Plantilla | Lista de lo verificable por API frente a checklist manual (la API v2 no expone el HTML de Automations). | Pendiente | |
| EO-8 | Cuenta | Cuota de campos y Automations del plan real. | Pendiente | |
| EO-9 | Rendering | Gmail, Outlook, Apple Mail, móvil, imágenes bloqueadas y carga tardía. | Pendiente | |

**Regla de salida:** la modalidad dinámica solo se activa si EO-4 y EO-5 demuestran que el contenido de cada entrega queda fijado antes de que otra campaña pueda sobrescribir los campos del mismo contacto. Mientras tanto se usan dos rutas: el HTML exportable y la Automation estática versionada, con CTA estático externo o sin CTA.

## 2. Redes sociales (gobierna `CONTENT_SOCIAL_PLATFORMS`)

| # | Red | Comprobación | Estado |
| --- | --- | --- | --- |
| SO-1 | Meta | Versión Graph vigente (WRCC usaba `v23.0`) y permisos `pages_manage_posts`, `pages_read_engagement`, `instagram_content_publish`, `business_management` concedidos. | Versión: `v25.0` (28-10-2026). Sin App Review: la app queda en modo desarrollo y las personas que administran las páginas del cliente se agregan como administradoras de la app, lo que alcanza para publicar en sus propias cuentas. Pendiente: probar SO-2/SO-3/SO-5 con esas cuentas. |
| SO-2 | Facebook | Post de texto, 1 foto y multi-foto en página de pruebas; un 5xx simulado en la llamada pública queda `uncertain` y no duplica. | Pendiente |
| SO-3 | Instagram | Imagen y carrusel desde URL pública de `content-public`; relación de aspecto 0.8–1.91 y ancho ≥ 320 validados en preflight. | Pendiente |
| SO-4 | LinkedIn | ~~Versión `LinkedIn-Version` vigente; organización frente a miembro; multiimagen.~~ | Descartado — fuera de alcance por decisión del cliente (2026-10-28) |
| SO-5 | Todas | Revocación de token: la cuenta pasa a `needs_reauth` y el preflight bloquea la publicación. | Pendiente |

Una red se añade a `CONTENT_SOCIAL_PLATFORMS` solo cuando sus filas estén superadas. La falta de aprobación de una red no bloquea la generación, la biblioteca ni el email.

## 3. Generación

| # | Comprobación | Estado |
| --- | --- | --- |
| GEN-1 | Proveedor de texto real (Gemini u OpenAI) con límites de uso para el equipo de prueba; se registran modelo, versión de prompt y uso. | En producción desde 10-2026 con OpenAI (`PROMPT_VERSION ai4l-2026-10-v1`). Un fallo `llm_invalid` del 18-10 (preheader > 120) quedó corregido ese día: los campos largos se recortan (761a821). Falta fijar el límite de gasto mensual en OpenAI. |
| GEN-2 | Generación de imágenes real (OpenAI) con presupuesto por entorno. | En producción desde 10-2026 (OpenAI). Falta el presupuesto mensual. |

## 4. Procedencia del código extraído

`services/content-engine/` es una copia adaptada de `C:/Projects/wrcc-content-studio`. Durante el análisis no se encontró una licencia explícita en ese repositorio. El propietario debe confirmar el derecho de reutilización antes del despliegue productivo (ver `services/content-engine/README.md`).
