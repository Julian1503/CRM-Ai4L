# Plan de experiencia de usuario para Ai4L CRM

Fecha de auditoría: 26 de agosto de 2026

## 1. Objetivo

Convertir la aplicación actual, que funciona principalmente como una consola técnica,
en una herramienta que una persona de ventas o administración pueda operar sin conocer
UUID, webhooks, variables de entorno ni estados internos de los proveedores.

El objetivo no es solamente simplificar textos. La experiencia debe prevenir errores,
mostrar el estado real de las operaciones y ofrecer una recuperación concreta cuando
EmailOctopus, Stripe, Calendly o la base de datos fallen.

## 2. Principios de decisión

1. La UI muestra decisiones de negocio; los identificadores técnicos quedan en una
   configuración avanzada de una sola vez.
2. Una acción irreversible debe mostrar alcance, validaciones y confirmación antes de
   ejecutarse.
3. El usuario nunca debe adivinar si una operación terminó, sigue ejecutándose o falló.
4. Los flujos masivos deben anticipar su impacto antes de modificar datos.
5. Un error debe indicar qué ocurrió, qué registros afecta y cuál es la siguiente acción.
6. La complejidad técnica no desaparece: se concentra en una vista de administración y
   se traduce a estados comprensibles para el resto de los usuarios.
7. La implementación se hará en entregas verticales pequeñas. Un rediseño total en una
   sola rama aumenta el riesgo y demora la mejora visible.

## 3. Diagnóstico por sección

### 3.1 Acceso

**Lo que funciona**

- Formulario corto, etiquetas correctas y atributos de autocompletado.
- El mensaje deja claro que el workspace es privado.

**Problemas**

- No existe control para mostrar u ocultar la contraseña.
- No se advierte Caps Lock ni se ofrece un camino visible para recuperar acceso.
- El mensaje de error debe comprobarse para evitar respuestas genéricas o técnicas.

**Respuesta**

- Añadir mostrar contraseña, aviso de Caps Lock y un enlace de soporte administrado.
- Mantener la creación de cuentas solo por administrador; no agregar registro público.
- Mostrar errores junto al formulario, conservar el email y enfocar el campo correcto.

**Por qué es la mejor respuesta**

No conviene añadir un flujo completo de registro o recuperación automática si el modelo
de acceso sigue siendo privado. Un camino de soporte explícito resuelve el bloqueo sin
abrir una superficie de seguridad innecesaria.

### 3.2 Navegación global y móvil

**Problemas**

- La navegación contiene siete opciones de primer nivel.
- En 390 px, `Settings` empieza fuera del viewport y `EmailOctopus` queda parcialmente
  fuera. El cierre de sesión también desaparece en móvil.
- Las vistas dependen de estado React. No tienen una URL propia, por lo que Refresh y
  Back pierden el contexto y no es posible compartir un enlace a una campaña o booking.
- La barra fija puede cubrir controles mientras el usuario recorre formularios largos.

**Respuesta**

- Desktop: agrupar en `Contacts`, `Marketing`, `Consultations` y `Settings`.
- Móvil: cuatro destinos como máximo: `Contacts`, `Campaigns`, `Bookings` y `More`.
  `More` abre Archive, Import, EmailOctopus, Settings y Sign out.
- Convertir las vistas a rutas con un layout compartido, por ejemplo `/contacts`,
  `/campaigns`, `/bookings`, `/imports` y `/settings/integrations`.
- Conservar filtros, página y pestaña en search params.
- Añadir espacio inferior medido contra la barra y desplazar el campo enfocado por encima
  de ella.

**Por qué es la mejor respuesta**

Comprimir siete iconos todavía más no resuelve descubribilidad ni alcance táctil. Un
menú `More` aplica el patrón móvil esperado y las rutas reales solucionan Back, Refresh,
deep links y restauración de estado con la misma inversión.

### 3.3 Dashboard y contactos

**Lo que funciona**

- Tabla escaneable, filtros por estado, job type y ubicación, paginación y exportación.
- El drawer reúne los datos importantes del contacto.

**Problemas**

- `Prospects` se calcula como todos los no clientes, aunque `Lead` es un estado separado.
- La UI no ofrece un filtro de Leads.
- La búsqueda promete nombre, organización y título; el backend busca nombre, apellido,
  email y organización, pero no título.
- `conversion rate` representa customers / total, no una conversión histórica real.
- Guardar puede fallar sin un mensaje visible en el drawer.
- El sync individual a EmailOctopus es fire-and-forget; el contacto puede parecer
  sincronizado aunque el proveedor haya fallado.
- Filas, sugerencias de dirección y drawer tienen brechas de teclado, foco y semántica.
- El formulario crea organizaciones por coincidencia exacta y puede producir duplicados
  por diferencias de mayúsculas o espacios.

**Respuesta UI**

- Reemplazar métricas ambiguas por `Contacts`, `Leads`, `Prospects`, `Customers` y
  `Newsletter subscribers`, o mostrar solo las cuatro más útiles.
- Añadir Lead a los filtros y mostrar chips removibles para los filtros activos.
- Corregir el placeholder de búsqueda o ampliar el backend para buscar título y teléfono.
- Convertir el drawer en un diálogo real: foco inicial, Escape, focus trap, retorno de
  foco, aviso de cambios sin guardar y errores inline.
- Autocompletar organización con resultados existentes y una opción explícita
  `Create new organisation`.
- Confirmar guardado con toast y mostrar el estado de sincronización de newsletter como
  `Synced`, `Pending` o `Needs attention`.

**Respuesta backend**

- Mover create/update a endpoints server-side y ejecutar contacto, servicios y resultado
  de sync como una operación observable.
- No bloquear el guardado del CRM si EmailOctopus está caído. Guardar una tarea de sync
  pendiente, mostrarla en UI y reintentar de forma segura.
- Normalizar el nombre de organización y devolver posibles duplicados antes de crear.
- Alinear búsqueda, filtros y conteos con la definición canónica de status.

**Por qué es la mejor respuesta**

Hacer que el guardado dependa de EmailOctopus convertiría una caída externa en una caída
del CRM. Una cola persistente mantiene el dato principal y, a la vez, evita el actual
fallo silencioso.

### 3.4 Archivo

**Lo que funciona**

- El soft delete es comprensible y existe restauración.

**Problemas**

- No hay búsqueda, filtro por fecha ni restauración masiva.
- No se registra o muestra quién archivó el contacto ni el motivo.
- La restauración no confirma éxito dentro de la aplicación.

**Respuesta**

- Añadir búsqueda por nombre/email/organización, filtro por antigüedad y selección
  múltiple con `Restore selected`.
- Registrar `archived_by` y un motivo opcional para auditoría.
- Mostrar toast de éxito y conservar filtros/página después de restaurar.

**Por qué es la mejor respuesta**

El archivo es una pantalla secundaria. No necesita un rediseño complejo; necesita las
herramientas mínimas para encontrar y recuperar registros con confianza.

### 3.5 Importación

**Lo que funciona**

- Existe automapping, validación previa y separación entre filas válidas e inválidas.

**Problemas**

- La dropzone dice `Drag and drop`, pero no implementa eventos de drop.
- La zona clickable no es un control accesible por teclado.
- Los encabezados del mapeo están invertidos: la primera columna muestra campos CRM,
  pero se llama `Spreadsheet Column Header`.
- El progreso queda en 0 y luego salta a 100; no describe el trabajo real.
- La validación no separa `new`, `will update`, `duplicate`, `archived conflict` e
  `invalid`.
- Las filas inválidas muestran un índice dentro del subconjunto, no la fila original.
- El resultado se comunica con `alert()` y después se abandona la pantalla.
- No existe un reporte descargable ni una forma segura de revertir una importación grande.

**Respuesta UI**

- Implementar un stepper persistente: `Choose file`, `Map columns`, `Review impact`,
  `Import`, `Results`.
- Usar un `<label>`/botón visible y eventos drag/drop reales.
- Titular las columnas `CRM field` y `Spreadsheet column`.
- Mostrar confianza del automapping y bloquear solo los campos requeridos sin mapear.
- En Review, mostrar conteos y muestras de altas, actualizaciones, duplicados, conflictos
  e inválidos. Usar el número de fila original.
- Permitir descargar errores como CSV.
- Dejar un resultado persistente con enlaces a contactos creados/actualizados.

**Respuesta backend**

- Añadir un endpoint de `dry run` que aplique las mismas reglas que la importación real.
- Crear `import_runs` e `import_run_items` para auditoría, resumen y descarga.
- Implementar rollback solo si ningún registro afectado fue editado después del import.
  Si hay cambios posteriores, ofrecer una reversión parcial explicada.

**Por qué es la mejor respuesta**

Una preview calculada solo en el navegador no puede anticipar correctamente duplicados y
conflictos existentes en la base. El dry run server-side garantiza que Review e Import
usen las mismas reglas. Un botón Undo sin historial sería peligroso; por eso el rollback
debe validar cambios posteriores.

### 3.6 Segmentos y campañas

**Lo que funciona**

- El preview cuenta la audiencia, excluye archivados/no suscritos y estima duración.
- Existen borrador, revisión, aprobación y ledger de envíos.
- El trabajo local actual empieza a conservar el motivo de un fallo y detecta envíos
  estancados. Debe mantenerse como base.

**Problemas**

- El usuario escribe `EmailOctopus automation ID` al crear y editar campañas.
- Las definiciones de segmentos se muestran como claves/valores internos; un job type
  puede aparecer como UUID.
- Segmentos y campañas están apilados en una sola página extensa.
- Es posible crear borradores incompletos sin una lista clara de pendientes.
- El flujo muestra `Claude`, merge tags y restricciones del proveedor como conceptos
  centrales.
- No hay envío de prueba ni preflight completo.
- `Send now` no confirma audiencia ni explica que la acción es irreversible.
- El loop de envío se conduce desde el navegador. Cerrar la pestaña interrumpe el avance.
- No hay una vista compacta de progreso, muestra de destinatarios ni acción por error.

**Respuesta al UUID**

La documentación oficial de EmailOctopus expone `Start automation`, pero no un endpoint
para listar automations. Por eso no es correcto prometer un picker obtenido del proveedor.
En cambio, las listas sí se pueden enumerar por API: Settings debe mostrar un selector
con el nombre de la lista y guardar el list ID internamente.

Se implementará un catálogo interno `Email automations`:

- El administrador agrega una automation una sola vez pegando su URL completa o ID.
- El sistema extrae y valida el formato, pide un nombre amigable y ejecuta un test a un
  destinatario controlado.
- Se guarda nombre, provider ID, lista asociada, estado, fecha de último test y si está
  habilitada.
- La campaña usa un select como `Free consultation - 30 min`, nunca el UUID.
- El ID solo se muestra dentro de `Advanced details`.
- Las campañas existentes se migran al catálogo sin perder `provider_automation_id` hasta
  completar el backfill.

**Respuesta al flujo**

- Separar biblioteca de audiencias y campaña activa.
- Crear wizard con autosave:
  1. `Audience`: elegir/crear segmento, ver conteo y una muestra de contactos.
  2. `Message`: escribir o generar copy con nombres amigables, sin merge tags visibles.
  3. `Delivery`: elegir una automation validada.
  4. `Test`: enviar a un email de prueba y confirmar recepción.
  5. `Review and send`: mostrar audiencia, exclusiones, automation, booking link e
     integraciones requeridas.
- Agregar confirmación final con cantidad exacta. Para audiencias grandes, pedir escribir
  el nombre de campaña.
- Sustituir estados internos por tareas: `Draft`, `Needs review`, `Ready to send`,
  `Sending 120/500`, `Sent`, `Needs attention`.

**Respuesta backend**

- Crear tabla/API del catálogo de automations con acceso solo administrativo.
- Crear un endpoint de test que no contamine las métricas de la campaña real.
- Ejecutar chunks con un worker persistente usando la infraestructura existente. La UI
  inicia el job y consulta progreso; cerrar el navegador no lo detiene.
- Conservar idempotencia y ledger por destinatario.
- El preflight debe validar consentimiento, audiencia, merge fields, automation testeada,
  URL pública, Stripe, Calendly y webhooks antes de habilitar envío.

**Por qué es la mejor respuesta**

- Mantener el UUID en cada campaña repite una decisión técnica y facilita errores.
- Intentar listar automations desde EmailOctopus no es viable con el API publicado.
- Un catálogo local resuelve la limitación sin añadir otro proveedor.
- Un worker externo nuevo agregaría mantenimiento. Reutilizar Supabase/Vercel y el ledger
  existente mantiene el sistema pequeño y permite reanudar de forma idempotente.

### 3.7 EmailOctopus sync

**Problemas**

- La sección se llama `EmailOctopus campaigns`, aunque gestiona sincronización.
- `Subscribers synced` usa el conteo local y no demuestra el total real del proveedor.
- `Active`, `On-demand` y `Background replication disabled` comunican estados
  contradictorios.
- La UI explica webhooks y API keys en vez de mostrar una configuración guiada.
- Sync usa alertas y no expone progreso por chunk o registros fallidos.
- El historial no permite filtrar fallos, abrir detalle o reintentar.

**Respuesta**

- Renombrar a `Email marketing sync`.
- Mostrar dos conteos con fuente: `Newsletter contacts in CRM` y `Subscribed in
  EmailOctopus`, más la diferencia a reconciliar.
- Usar estados `Connected`, `Setup required`, `Syncing`, `Needs attention`.
- Añadir `Preview sync`: add/update/unsubscribe/unchanged antes de ejecutar.
- Mostrar progreso y resultado persistente, con CSV de fallos y retry solo de fallidos.
- Mover endpoints, tags y webhook secrets a Advanced. Mostrar `Last subscriber webhook`
  y `Last successful sync` en lenguaje simple.

**Por qué es la mejor respuesta**

Un porcentaje de densidad local no verifica integración. Comparar ambas fuentes responde
la pregunta real: si las listas coinciden y qué hará Sync now.

### 3.8 Bookings para administradores

**Problemas**

- Siete tabs compiten en móvil y no existe búsqueda por persona/campaña/fecha.
- `Claiming` y `paid` no describen con claridad una transacción de $0.
- El aviso indica revisar `invitee.created`, pero no ofrece un lugar o acción para hacerlo.
- No existe detalle con timeline Stripe -> Calendly, enlace al proveedor o acción de
  seguimiento.
- Cuatro tarjetas grandes desplazan la lista debajo del primer viewport móvil.

**Respuesta**

- Usar un resumen compacto con un filtro principal `Needs action`.
- Estados de negocio: `Link sent`, `Checkout opened`, `Choose a time`, `Scheduled`,
  `Cancelled`, `Expired`.
- Añadir búsqueda, rango de fechas y campaña.
- Abrir un detalle con timeline, contacto, campaña, valor, resultado Stripe, evento
  Calendly y último error.
- Acciones seguras: copiar/reemitir enlace si corresponde, abrir contacto, abrir evento
  del proveedor y marcar seguimiento.
- Reemplazar el texto del webhook por `Scheduling updates are delayed` con un botón
  `Open integration health`.

**Por qué es la mejor respuesta**

La tabla actual informa pero no permite resolver. Priorizar `Needs action` convierte el
dashboard en una cola de trabajo y mantiene los detalles técnicos disponibles solo al
investigar un caso.

### 3.9 Flujo público Stripe + Calendly

**Lo que funciona**

- El backend verifica sesión Stripe, monto $0 y booking antes de mostrar Calendly.
- El usuario no necesita datos de tarjeta y el iframe conserva el contexto de marca.

**Problemas**

- `Your consultation is reserved` aparece antes de elegir un horario.
- El paso por Stripe para una transacción $0 puede sentirse inesperado.
- No hay una indicación global de los dos pasos ni una confirmación propia al terminar
  Calendly.

**Respuesta**

- Cambiar el primer mensaje a `Your free consultation is ready to claim`.
- Mostrar un stepper corto: `Confirm free offer` y `Choose a time`.
- Mantener Stripe porque la transacción $0 es un requisito del negocio, pero explicar
  antes del click que no se pedirá tarjeta.
- Escuchar el evento de Calendly y mostrar confirmación final con fecha, zona horaria y
  expectativa del email de calendario. Mantener el webhook como verdad backend.

**Por qué es la mejor respuesta**

Eliminar Stripe simplificaría UX, pero incumpliría el requerimiento. Explicar el paso y
mostrar progreso reduce sorpresa sin cambiar la lógica comercial.

### 3.10 Settings y salud operacional

**Problemas**

- Settings expone Supabase URL, anon key, API key y list ID en una consola para usuarios
  no técnicos.
- La API key de EmailOctopus llega al cliente para editarse.
- Stripe y Calendly no tienen tarjetas de configuración o salud equivalentes.
- Operational health usa métricas como `24h deliveries` y `events`, pero no permite abrir
  los fallos ni repararlos.

**Respuesta UI**

- Pantalla principal con tarjetas para Database, EmailOctopus, Stripe, Calendly y AI copy.
- Cada tarjeta muestra `Connected`, `Setup required` o `Needs attention`, última
  verificación y una acción `Test connection` o `Fix setup`.
- Ocultar valores internos. `Advanced technical details` muestra IDs, endpoint y webhook
  solo a administradores.
- Abrir los fallos operacionales en una lista con proveedor, entidad afectada, hora,
  mensaje traducido, detalle técnico colapsado y retry cuando sea idempotente.

**Respuesta backend**

- Mover lectura/escritura de secretos a endpoints server-only; nunca devolver el valor
  completo al navegador.
- Cifrar secretos almacenados o moverlos al proveedor de variables de entorno si no deben
  editarse en runtime.
- Crear un contrato común de health checks y devolver estados normalizados.

**Por qué es la mejor respuesta**

Ocultar los inputs con type=password no evita que el valor exista en el cliente. La
separación server-side mejora seguridad y permite una UI basada en estado, que es lo que
el usuario realmente necesita.

## 4. Fundaciones transversales

### 4.1 Feedback

- Crear Toast para éxito no bloqueante.
- Crear Alert inline persistente para errores que requieren acción.
- Crear ConfirmDialog accesible para acciones de riesgo.
- Estandarizar mensajes con `qué pasó`, `qué se conservó` y `qué hacer ahora`.
- Eliminar `window.alert()` y `window.confirm()` de los flujos principales.

### 4.2 Accesibilidad

- Corregir tokens: blanco sobre `#01ACDB` tiene 2.65:1, secondary sobre el fondo 3.87:1
  y muted sobre blanco 2.68:1. El objetivo es WCAG AA.
- Etiquetar inputs de Settings, botones icon-only y controles dinámicos.
- Hacer navegables filas, dropzone, sugerencias, tabs y drawers por teclado.
- Añadir `aria-live` para progreso, envío, sync e import.
- Validar 200% zoom, reduced motion y touch targets de 44 x 44 px.

### 4.3 Arquitectura UI

- Dividir el `page.tsx` monolítico en rutas y componentes de dominio.
- Crear un layout autenticado compartido.
- Mantener filtros y páginas en URL.
- Crear componentes comunes de StatusBadge, EmptyState, ErrorState, Progress y DetailDrawer.

## 5. Orden de implementación

### Fase 0 - Seguridad operacional y móvil

Duración estimada: 4 a 6 días.

1. Preflight y confirmación de `Send now`.
2. Envío de prueba a destinatario controlado.
3. Modal accesible de confirmación y alertas persistentes.
4. Navegación móvil con `More`, Settings y Sign out alcanzables.
5. Corregir contrastes críticos y labels de Settings.
6. Integrar el motivo de fallo de campaign send que ya está en trabajo local.

**Salida verificable**

- No se puede enviar una campaña real sin test, preflight y confirmación del alcance.
- Todas las secciones y Sign out son accesibles a 320/390 px.
- Un fallo de envío indica destinatarios afectados, motivo y siguiente acción.

### Fase 1 - Rutas, catálogo de integraciones y secretos server-side

Duración estimada: 7 a 10 días.

1. Crear el layout autenticado y migrar las vistas a rutas estables antes de reconstruir
   los flujos largos. Mantener redirects compatibles durante la transición.
2. Tabla/API de Email automations con migración de campaigns existentes.
3. Wizard para URL/ID, nombre amigable y envío de prueba.
4. Selector de automation por nombre en campaigns.
5. Health cards de Database, EmailOctopus, Stripe y Calendly.
6. Mover API keys y secretos fuera del cliente.

**Salida verificable**

- Un usuario crea una campaña sin ver ni escribir un UUID.
- Un administrador puede identificar una integración rota y ejecutar una prueba desde
  la misma pantalla.
- Refresh, Back y los enlaces directos conservan la sección activa.

### Fase 2 - Campaña guiada y worker persistente

Duración estimada: 8 a 12 días.

1. Wizard Audience -> Message -> Delivery -> Test -> Review.
2. Preview con muestra de contactos y exclusiones.
3. Estados orientados a tarea y checklist de pendientes.
4. Worker de chunks idempotente que sobrevive al cierre del navegador.
5. Progreso, pausa/reanudación y reporte por destinatario.

**Salida verificable**

- Un usuario nuevo puede preparar una campaña sin documentación externa.
- Cerrar y reabrir la pestaña no pierde progreso ni duplica envíos.

### Fase 3 - Contactos e importación confiables

Duración estimada: 8 a 12 días.

1. Corregir métricas, Lead y contrato de búsqueda.
2. Guardado server-side con feedback y sync pendiente visible.
3. Drawer accesible y organizaciones con autocomplete.
4. Stepper de import, drop real y encabezados correctos.
5. Dry run, categorías de impacto, reporte y audit log.
6. Rollback condicionado a ausencia de ediciones posteriores.

**Salida verificable**

- Antes de importar, altas/updates/conflictos coinciden con el resultado final.
- Ningún fallo de guardado o EmailOctopus queda solo en consola.

### Fase 4 - Consultations como cola de trabajo

Duración estimada: 5 a 8 días.

1. Filtro `Needs action`, búsqueda y rango de fechas.
2. Detail drawer con timeline Stripe/Calendly y acciones.
3. Salud operacional enlazada desde el caso afectado.
4. Stepper público y copy previo a Stripe corregido.
5. Confirmación final tras el evento de Calendly.

**Salida verificable**

- Un operador identifica y resuelve un booking estancado sin conocer nombres de webhook.
- El destinatario entiende por qué pasa por Stripe y qué falta para quedar agendado.

### Fase 5 - Eficiencia y cierre de accesibilidad

Duración estimada: 5 a 8 días.

1. Persistir filtros y páginas en las URLs creadas en Fase 1.
2. Vistas guardadas y acciones masivas donde aporten valor.
3. Archivo con búsqueda y restauración masiva.
4. Auditoría WCAG completa y pruebas de teclado/lector.
5. Pruebas responsive en 320, 390, 768, 1024 y 1440 px.

## 6. Criterios de aceptación globales

1. Una persona no técnica puede crear y enviar una campaña sin escribir un ID.
2. Una campaña real nunca comienza sin mostrar destinatarios, test y confirmación.
3. Todo proceso de más de dos segundos muestra estado y puede recuperarse tras Refresh.
4. Import Review y resultado real coinciden para altas, updates y conflictos.
5. Todos los fallos visibles ofrecen una siguiente acción concreta.
6. Todos los destinos y Sign out son accesibles en móvil.
7. Flujos principales se completan solo con teclado.
8. Texto, placeholders, botones y estados alcanzan WCAG AA.
9. Ningún secreto completo se entrega al navegador.
10. Back, Refresh y deep links conservan la tarea actual.

## 7. Estrategia de pruebas

- Unit tests para copy de errores, estados normalizados y validación de preflight.
- Integration tests para catálogo de automations, secrets server-side, dry run/import y
  workers idempotentes.
- E2E para campaña test -> approve -> confirm -> send -> progress -> result.
- E2E para import new/update/conflict/invalid y rollback permitido/bloqueado.
- E2E para Stripe $0 -> Calendly -> booking confirmado.
- E2E móvil que compruebe bounding boxes de todos los destinos y ausencia de overflow.
- Axe/Playwright para contraste, nombres accesibles, focus trap y navegación de teclado.
- Pruebas de fallo inyectado para timeout/rate limit de EmailOctopus, webhook faltante,
  Stripe no configurado y Calendly no disponible.

## 8. Métricas de éxito

- Tiempo para crear una campaña de prueba sin ayuda: menos de 5 minutos.
- Cero campañas reales enviadas sin confirmación de audiencia.
- Cero operaciones fallidas comunicadas únicamente por consola o alert genérico.
- Menos de 2% de filas de import con resultado distinto al dry run.
- 100% de integraciones con estado, última verificación y acción de recuperación.
- Tareas críticas completables a 320 px y mediante teclado.

## 9. Decisiones que no se recomiendan

- No reemplazar UUID por otro campo de texto con instrucciones más largas.
- No construir un falso selector remoto de automations que EmailOctopus no permite listar.
- No eliminar Stripe del booking mientras la transacción $0 sea requisito contractual.
- No convertir todo en un wizard: Contacts y Archive se benefician de vistas directas.
- No ocultar errores técnicos sin conservar `Advanced details` para soporte.
- No agregar un proveedor de colas antes de comprobar que la infraestructura actual puede
  ejecutar los chunks persistentes con idempotencia.
