---
target: Auditoria UX integral de la aplicacion
total_score: 18
p0_count: 1
p1_count: 9
timestamp: 2026-08-26T02-28-12Z
slug: src-app-page-tsx
---
# Auditoria UX integral de Ai4L CRM

## Design Health Score

| # | Heuristica | Puntaje | Problema principal |
|---|---|---:|---|
| 1 | Visibilidad del estado | 2/4 | Hay loaders, pero varias acciones usan alertas, fallos silenciosos o progreso no persistente. |
| 2 | Relacion sistema / mundo real | 2/4 | UUID, webhooks, merge fields y estados internos aparecen en tareas de negocio. |
| 3 | Control y libertad | 2/4 | Existe restauracion y retorno a borrador, pero no hay undo de import, prueba previa o proteccion fuerte al enviar. |
| 4 | Consistencia | 2/4 | Se mezclan banners, alert(), texto tecnico y estados con distinto nivel de detalle. |
| 5 | Prevencion de errores | 1/4 | Send now no tiene preflight ni confirmacion; import no anticipa actualizaciones y duplicados. |
| 6 | Reconocimiento sobre memoria | 1/4 | El usuario debe traer IDs y recordar configuraciones de EmailOctopus. |
| 7 | Flexibilidad y eficiencia | 2/4 | Hay filtros, paginacion y CSV, pero faltan vistas guardadas, busqueda en bookings y acciones masivas. |
| 8 | Diseno estetico y minimalista | 3/4 | La jerarquia es legible, aunque hay tarjetas demasiado grandes y explicaciones tecnicas extensas. |
| 9 | Diagnostico y recuperacion | 2/4 | Marketing empieza a mostrar motivos de fallo, pero contactos, sync e import todavia pierden contexto. |
| 10 | Ayuda y documentacion | 1/4 | La ayuda es tecnica y no esta organizada como pasos orientados a una tarea. |
| **Total** | | **18/40** | **Pobre: la base funciona, pero exige conocimiento tecnico y tiene riesgos operativos.** |

## Anti-Patterns Verdict

La interfaz no parece una plantilla generica, pero si una consola construida desde el modelo de datos. La composicion es clara y consistente; el problema no es decorativo sino de arquitectura de informacion, lenguaje y seguridad operativa.

El detector estatico encontro una transicion de ancho en el progreso de importacion. El detector de navegador encontro entre 15 y 16 advertencias por vista. La inspeccion manual confirmo fallos mas importantes que esas advertencias: contraste insuficiente de los tokens secundarios, navegacion movil fuera del viewport y controles sin etiqueta o acceso por teclado.

## Impresion general

La app permite completar las tareas, pero obliga al usuario a entender Supabase, UUID, Started via API, webhooks y estados de proveedor. La mayor oportunidad es convertir funciones tecnicas sueltas en flujos guiados con preflight, confirmacion, progreso y recuperacion.

## Lo que funciona

- La tabla de contactos, los filtros y la exportacion forman una base clara y escaneable.
- Archivo tiene una regla comprensible de soft delete y permite restaurar registros.
- Marketing ya calcula el tamano de audiencia y el trabajo local en curso conserva y muestra el motivo de un send fallido.

## Problemas prioritarios

1. **P0 - Envio irreversible sin preflight.** Send now puede iniciar correos reales sin prueba, resumen final o confirmacion del numero de destinatarios.
2. **P1 - IDs y jerga de proveedor en flujos diarios.** Automation ID, list ID, claves de definicion de segmentos y webhooks exigen conocimiento tecnico.
3. **P1 - Importacion que no construye confianza.** La zona promete drag and drop sin manejar drop, los encabezados del mapeo estan invertidos y no se anticipan altas, actualizaciones, duplicados o conflictos.
4. **P1 - Feedback e integridad inconsistentes.** Guardar un contacto puede fallar solo en consola y su sync a EmailOctopus es fire-and-forget; alert() se usa en settings, import y sync.
5. **P1 - Experiencia movil incompleta.** Settings queda totalmente fuera del viewport, EmailOctopus parcialmente fuera y no hay cierre de sesion movil.
6. **P1 - Accesibilidad.** Blanco sobre #01ACDB da 2.65:1; texto secundario sobre el fondo da 3.87:1; filas, dropzone y drawer tienen brechas de teclado y foco.

## Persona red flags

**Alex, usuario experto:** no puede enlazar una vista concreta, volver con Back, guardar filtros ni ejecutar acciones masivas. El envio depende de mantener la pantalla activa y no tiene progreso durable.

**Jordan, primer uso:** no sabe que es un automation ID, como revisar un webhook ni por que debe pasar por Stripe para pagar $0. La ayuda explica arquitectura, no el siguiente paso.

**Sam, teclado o lector de pantalla:** no puede activar la dropzone prometida, seleccionar sugerencias de direccion de forma robusta ni usar el drawer como dialogo con foco contenido. Varios textos y botones no alcanzan contraste AA.

**Casey, movil:** Settings no es alcanzable desde la barra inferior, seis elementos ya desbordan y el contenido operativo queda oculto por tarjetas grandes antes de llegar a la accion.

## Observaciones menores

- Dashboard llama conversion rate a customers / total, y Prospects incluye en realidad todos los no clientes, incluso leads.
- La busqueda promete title, pero el backend busca nombre, apellido, email y organizacion.
- El area de bookings muestra siete tabs y explica invitee.created, pero no ofrece una accion de recuperacion.
- La pagina publica dice que la consulta esta reservada antes de elegir fecha.
- Subscribers Synced usa el conteo del CRM, no demuestra el total real de EmailOctopus.

## Preguntas de diseno

- Que informacion necesita un representante comercial y que deberia quedar solo en Advanced para un administrador tecnico?
- Puede una campana considerarse lista si aun no envio una prueba a un destinatario controlado?
- En una importacion, que nivel de actualizacion automatica es aceptable sin confirmacion explicita?
