# Plan de implementación: mejoras solicitadas por el cliente

Fecha: 29 de septiembre de 2026.
Estado: fases 0–3 implementadas el 29/09/2026 (ver sección 9); pendientes la verificación con Supabase local y los grupos persistentes por etiquetas.

## 1. Objetivo y alcance

Implementar cinco mejoras:

1. Ayuda con las columnas obligatorias para importar Excel.
2. Etiquetas en contactos: asignación individual, selección múltiple, importación y filtros.
3. Acceso y edición del catálogo de Job Types.
4. Filtros por organización y sector (Industry).
5. Mostrar/ocultar contraseña en login.

Este documento se basa en el árbol de trabajo actual, incluidos los cambios locales. Se consultó primero el grafo MCP y se verificó la fuente local: el grafo no refleja todas las mejoras recientes. No se modificó código de producto ni se ejecutaron migraciones. Tampoco se comprobó el contenido de la base desplegada ni se ejecutaron pruebas en esta fase de planificación.

## 2. Qué existe y qué falta

| Área | Situación actual | Trabajo necesario |
| --- | --- | --- |
| Plataforma | Next.js 16.3.6, React 19, Supabase/Postgres, CSS Modules, Jest y Playwright. | Seguir las guías locales de Next en `node_modules/next/dist/docs/` antes de implementar. Se revisó `use-client.md` para login. |
| Importación | Lectura de archivos, mapeo automático/manual, validación, previsualización, rechazo de filas y detección de preview obsoleto. | Ayuda de requisitos y soporte completo de etiquetas. |
| Contactos | Guardado mediante `save_contact`, transaccional y con `expectedRevision`. | Incluir etiquetas sin perder atomicidad ni detección de cambios concurrentes. |
| Selección | La tabla ya permite seleccionar contactos entre páginas. | Reutilizarla para añadir/quitar etiquetas a la selección. |
| Etiquetas | No existe un catálogo de etiquetas CRM ni una relación contacto-etiqueta. | Modelo, operaciones, visualización, importación y filtros nuevos. |
| Job Types | Existen catálogo, asignación en el drawer, importación y filtro. | Pantalla accesible para consultar, crear y renombrar tipos. |
| Organización | Existe `organisation_id`; la búsqueda de texto incluye nombres de organizaciones. Los segmentos ya tienen `organisationId`. | Filtro explícito en contactos, con opciones obtenidas del servidor. |
| Industry | Existe `organisations.industry`; los flujos actuales de guardado/importación no lo pueblan. | Si es un sector separado, permitir mantener ese dato y filtrarlo. |
| Login | `LoginForm.tsx` es Client Component, usa Server Action y siempre muestra un input `password`. | Botón de mostrar/ocultar con estado local. |

Referencias de comportamiento vigente: `docs/IMPORTS.md` y `docs/ACCESS_CONTROL.md`. Los endpoints nuevos deben respetar la membresía activa; las políticas de base de datos también deben impedir accesos no autorizados.

## 3. Decisiones de producto y contratos iniciales

Hay dos preguntas planteadas al usuario que siguen abiertas al redactar este plan:

- **Grupo de personas:** se propone interpretar el pedido como selección múltiple de contactos. Los grupos persistentes independientes serían una ampliación. Los segmentos actuales pueden servir para audiencias guardadas, pero todavía no admiten criterios de etiquetas.
- **Industry:** se propone tratarlo como sector de la organización, separado de Job Type. Si el cliente usa ambos nombres para el mismo concepto, se elimina el trabajo de mantener un sector separado y se conserva un solo filtro.

Estas decisiones no bloquean login, ayuda de requisitos ni la base de etiquetas. Sí deben resolverse antes de cerrar el mapeo de Industry y el alcance de grupos guardados.

Contratos propuestos para iniciar desarrollo:

- Etiquetas propias del CRM; su relación con EmailOctopus queda fuera del pedido actual.
- Nombre de etiqueta único tras recortar espacios y comparar sin distinguir mayúsculas. Conservar una etiqueta legible para mostrarla.
- Manual: añadir o quitar etiquetas. Importación: añadir; una celda vacía o sin mapear conserva lo existente.
- Columna `Tags`, con separador documentado `;`, por ejemplo `VIP; Workshop 2026`. Deduplicar valores y validar límites en cliente y servidor. Propuesta inicial: 80 caracteres por nombre y 50 etiquetas por contacto; rechazar excesos, sin truncarlos.
- La importación podrá aplicar etiquetas comunes a todas las filas aceptadas, además de las etiquetas de cada fila.
- Filtro de varias etiquetas: **cualquiera de las seleccionadas**. Entre familias de filtros se aplica AND: etiqueta + organización + sector + estado, etc.
- Cambios masivos sobre IDs explícitos, con límite de 2.000 contactos coherente con la selección actual. Selección vacía nunca significa todos los contactos.
- Operadores y administradores activos podrán gestionar estas funciones, siguiendo la matriz vigente. Si se requiere restringir catálogos a administradores, cambiar API y RLS conjuntamente.
- Job Types: consultar, crear y renombrar conservando el ID. Borrado, fusión y archivado quedan fuera del alcance inicial.

## 4. Implementación por funcionalidad

### A. Ayuda de columnas obligatorias

**Comportamiento:** mostrar ayuda antes de subir el archivo y durante el mapeo. Indicar `Email + First Name + Last Name`, o `Email + Full Name`; la validación actual exige que Full Name pueda dividirse en nombre y apellido. Los encabezados pueden tener otros nombres porque existe mapeo manual. Las columnas adicionales son opcionales.

1. Extraer los metadatos de campos actualmente definidos como `CRM_FIELDS` dentro de `page.tsx` a un módulo compartido.
2. Compartir la definición de requisitos entre ayuda y validación del mapeo. Conservar la validación de contenido por fila.
3. Añadir tooltip accesible por hover y foco, con apertura por clic para pantallas táctiles, cierre con Escape y relación `aria-describedby` cuando corresponda.
4. Marcar requisitos en el mapeo y explicar qué falta antes de pasar al preview. Evitar depender exclusivamente del atributo `title`.
5. Explicar que las celdas vacías no borran datos existentes y mostrar el formato de etiquetas cuando esté disponible.

**Modificar:** `src/app/page.tsx`, `src/lib/contacts/columnMapping.ts`, `src/lib/excelParser.ts`, `docs/IMPORTS.md`.

**Crear:** `src/lib/contacts/importFields.ts`, `src/components/import/ImportRequirements.tsx` y su CSS Module si lo necesita.

**Aceptación:** la ayuda coincide con la validación real; funciona con teclado y táctil; un mapeo incompleto muestra el requisito concreto; siguen funcionando ambas formas de nombre.

### B. Etiquetas individuales, masivas y desde archivo

#### Modelo y escritura

Crear `tags` y `contact_tags` con claves foráneas, unicidad de nombre normalizado y unicidad de `(contact_id, tag_id)`. Añadir índices para lectura por contacto y filtro por etiqueta. Activar RLS para miembros aprobados y verificar permisos de las funciones RPC.

Ampliar `save_contact` mediante una migración nueva para que contactos, servicios y etiquetas se guarden en una sola transacción. En el contrato manual, `tagIds` ausente conserva las etiquetas y `tagIds: []` las elimina explícitamente; esta distinción protege clientes que todavía no envían el campo.

Proponer `POST /api/contacts/tags` con `{ contactIds, tagIds, operation: 'add' | 'remove' }`, respaldado por una RPC transaccional. Validar todos los IDs antes de escribir; si hay un contacto no disponible o una etiqueta inválida, rechazar el lote e indicar que se actualice la selección. Operaciones repetidas deben ser idempotentes.

Toda modificación efectiva de etiquetas debe incrementar `contacts.revision`, también desde una RPC masiva o importación. Bloquear filas en orden estable para evitar conflictos entre lotes. Esto permite rechazar un drawer o preview que quedó obsoleto. Evitar una segunda escritura desde el navegador después del guardado del contacto.

Proponer `GET/POST /api/tags` para buscar y crear etiquetas. Paginar el catálogo; no suponer que todas las etiquetas caben en el límite de referencias de la página. Capturar duplicados concurrentes y devolver la etiqueta existente o un conflicto útil.

#### Interfaz y consultas

- `TagPicker` reutilizable en drawer, acción masiva e importación.
- Mostrar etiquetas en la ficha y en la tabla, con resumen cuando sean muchas.
- `BulkTagActions` reutiliza los IDs ya seleccionados y muestra una cantidad explícita antes de aplicar. Conservar la selección si falla la operación.
- Añadir filtro de etiquetas a `FilterBar`; integrar limpieza de filtros, reinicio de paginación y selección conforme al comportamiento actual.
- Aplicar filtros en servidor con SQL/EXISTS o una relación PostgREST verificada. El resultado debe contener cada contacto una sola vez, incluso si coincide con varias etiquetas.
- Propagar los mismos filtros al conteo y a la exportación. Añadir columna `Tags` al CSV completo con el mismo separador de importación.

#### Importación

Añadir `tagNames` al resultado validado y `tag_names` al payload SQL. La combinación de etiquetas por fila y etiquetas comunes se debe calcular antes del preview y reutilizarse al importar.

Extender `_stage_import_rows`, `preview_import_contacts` e `import_contacts` en una migración nueva, tomando como referencia las definiciones vigentes de `supabase/migrations/20261004010000_import_field_presence.sql` y `save_contact` de `20261004000000_contact_save.sql`.

El preview debe contar como actualizado un contacto que solo recibe etiquetas nuevas y mostrar las etiquetas que se crearán/asignarán, sin escribir el catálogo durante el preview. Invalidar y recalcular el preview al cambiar mapeo o etiquetas comunes. Conservar el token de concurrencia, las reglas de emails duplicados, las colisiones con archivados y las reglas de consentimiento. La importación repetida debe resultar estable.

**Modificar:**

- `src/lib/db/types.ts`, `src/lib/contacts/save.ts`; revisar `saveHandler.ts` y las rutas de contactos si cambia el formato de respuesta.
- `src/lib/contacts/query.ts`, `repository.ts`, `export.ts`.
- `src/lib/contacts/columnMapping.ts`, `src/lib/excelParser.ts`, `src/lib/contacts/import.ts`.
- `src/components/ContactDrawer.tsx`, `ContactTable.tsx` y sus CSS Modules; `TableContact` está definido en `ContactTable.tsx`.
- `src/components/contacts/FilterBar.tsx` y su CSS Module.
- `src/components/import/ImportChangePreview.tsx`.
- `src/app/page.tsx`, y `page.module.css` solo donde sea necesario; `docs/IMPORTS.md`, `docs/ACCESS_CONTROL.md`.

**Crear:**

- `src/lib/contacts/tags.ts`.
- `src/components/contacts/TagPicker.tsx`, `BulkTagActions.tsx` y estilos locales.
- `src/app/api/tags/route.ts`, `src/app/api/contacts/tags/route.ts`.
- Migraciones nuevas bajo `supabase/migrations/` y verificaciones bajo `supabase/tests/`. Elegir versiones posteriores a la última existente, actualmente `20261005000000`; no editar migraciones históricas.

**Aceptación:** asignación individual y entre páginas, quitar solo las etiquetas indicadas, reimportar sin duplicados, vacíos conservan datos, preview sin efectos laterales, rollback completo ante fallos y detección de edición concurrente. Listado, conteo y exportación coinciden.

### C. Acceso y edición de Job Types

Añadir una sección **Settings > Job Types**, reutilizando la vista Settings existente, y un acceso **Manage job types** junto al selector de contactos. No hace falta una nueva vista global de navegación para el alcance inicial.

1. Crear API para listado/búsqueda, alta y renombrado: `GET/POST /api/job-types` y `PATCH /api/job-types/[id]`.
2. Validar nombres no vacíos, longitud y duplicados usando la misma normalización de la base.
3. Renombrar conservando ID: contactos y definiciones de segmentos seguirán apuntando al mismo registro.
4. Refrescar opciones tras guardar para que drawer y filtros no conserven nombres obsoletos. Mantener el borrador del contacto al gestionar el catálogo.
5. Mantener la asignación manual existente y el comportamiento actual de alta de tipos durante importación.

**Crear:** `src/components/settings/JobTypesSettings.tsx`, su CSS Module, las dos rutas anteriores y `src/lib/contacts/jobTypes.ts` para reglas compartidas si resultan necesarias.

**Modificar:** `src/app/page.tsx`, `src/components/ContactDrawer.tsx`; ajustar `FilterBar.tsx` solo si cambia el contrato de opciones. `src/components/Sidebar.tsx` no necesita cambios si se usa Settings como entrada.

**Base de datos:** el catálogo ya tiene unicidad normalizada y soporte de lectura/alta/actualización. No se necesita una migración de estructura para este CRUD mínimo; verificar las políticas con miembros activos en pruebas.

**Dependencia a revisar:** `supabase/sync-job-types.js` relaciona nombres con tags históricos de EmailOctopus. Documentar el efecto de renombrar y comprobar cómo se utiliza antes de ejecutar ese script de nuevo. No convertir automáticamente esos tags en etiquetas CRM.

**Efecto verificado del renombrado (29/09/2026):** `sync-job-types.js` asocia tags de EmailOctopus con job types por nombre exacto (`TAG_TO_JOB_TYPE`: "RTOs" → "Registered Training Organisation", "Learning and Development" → sí mismo). Si se renombra uno de esos dos tipos, el script informa "no matching job_types row" y omite esos contactos; las asignaciones existentes no cambian porque apuntan al ID. Tras renombrar, actualizar `TAG_TO_JOB_TYPE` antes de volver a ejecutar el script. Riesgo: renombrar un tipo y crear otro con el nombre antiguo haría que el script reasigne los contactos etiquetados al tipo nuevo, porque también corrige asignaciones que discrepan del tag.

**Aceptación:** acceder al catálogo sin SQL, crear y renombrar, rechazar duplicados legiblemente, conservar asignaciones y mantener disponibles los filtros y segmentos existentes.

### D. Filtros por organización e Industry

#### Organización, trabajo independiente de la ambigüedad de Industry

Añadir `organisationId` al contrato de filtros de contactos. Usar selector con búsqueda y opciones paginadas desde el servidor. Aplicar igualdad por ID, combinable con los demás filtros, y propagar a conteo/exportación. No derivar las opciones únicamente de los contactos de la página actual.

**Modificar:** `src/lib/contacts/query.ts`, `repository.ts`, `src/components/contacts/FilterBar.tsx`, su CSS Module y `src/app/page.tsx`. Revisar `src/app/api/contacts/route.ts` y `src/app/api/contacts/export/route.ts`, que ya consumen la infraestructura compartida.

**Crear:** `src/app/api/organisations/route.ts` para búsqueda paginada y `src/lib/contacts/organisations.ts` para la consulta compartida.

#### Industry como sector separado, propuesta pendiente de confirmación

Reutilizar `organisations.industry`; no crear otro catálogo sin necesidad. Normalizar espacios y comparación de mayúsculas. Una organización tiene un sector compartido por sus contactos.

El filtro necesita una fuente de datos mantenible: añadir edición mínima del sector de una organización en Settings, con nombre de la organización y explicación de que afecta a todos sus contactos. Proponer `OrganisationSettings.tsx` y `PATCH /api/organisations/[id]`, con detección de cambios concurrentes mediante el valor esperado o una revisión de organización. Revisar datos existentes antes de decidir limpieza o índices.

Añadir `industry` al contrato de filtros y resolverlo en servidor sobre la relación con organizaciones. Evitar listas enormes de IDs en URLs; comprobar joins, conteos y límites con datos suficientes. Obtener opciones de sector distintas del servidor mediante la misma infraestructura de organizaciones.

**Modificar adicionalmente:** `src/lib/db/types.ts` y las proyecciones de organización de la página/repositorio cuando sea necesario. Crear migración solo para índices, función de consulta o control de revisión que la implementación requiera; el campo ya existe.

**Importación, punto que requiere decisión:** `src/lib/contacts/columnMapping.ts` actualmente asigna `industry` y `sector` a `jobTypeName`. Si son conceptos distintos, mostrar ese encabezado como ambiguo y exigir elección explícita; no reinterpretar archivos antiguos silenciosamente. Si se incorpora carga de sectores desde archivo, añadir `Organisation Industry` como campo inequívoco, ampliar parser/payload/RPC y preview. Detectar sectores contradictorios para la misma organización dentro del archivo y cambios sobre organizaciones compartidas. El token de preview debe cubrir también esos datos de organización. Esta ampliación se coordina con el agente de importación.

**Aceptación:** organización y sector se combinan con búsqueda, estado, job type y etiquetas; limpiar filtros reinicia todos; no aparecen contactos duplicados; sin coincidencias devuelve cero; CSV y total representan exactamente el mismo conjunto.

### E. Mostrar/ocultar contraseña

**Modificar únicamente para la funcionalidad:** `src/app/login/LoginForm.tsx` y `src/app/login/login.module.css`.

- Estado local `showPassword`, inicialmente falso, alternando el tipo del mismo input.
- Botón de ojo `type="button"`, con nombre accesible `Show password` / `Hide password`, icono decorativo y foco visible.
- Mantener valor, nombre del campo, `autoComplete="current-password"`, errores y Server Action existentes.
- Ajustar padding para que el icono no tape texto ni interfiera con gestores de contraseñas.

**Aceptación:** clic y teclado alternan visibilidad sin enviar el formulario ni borrar el valor. Verificación visual en móvil y escritorio. Ampliar el recorrido existente de login en `src/e2e/auth.spec.ts`; no hace falta cambiar autenticación ni base de datos.

## 5. Secuencia y reparto entre subagentes

Máximo disponible: coordinador y tres subagentes simultáneos. El objetivo es repartir por propiedad de archivos, ya que varias funciones confluyen en los mismos módulos.

### Fase 0: preparación secuencial, coordinador

1. Registrar el estado de los cambios locales y la base de trabajo sin descartar ni reescribir cambios existentes. Si se usan worktrees, partir de una instantánea que incluya esa base, no solamente de HEAD.
2. Resolver las dos decisiones de alcance o mantener explícitamente sus ramas pendientes.
3. Fijar tipos y contratos: etiquetas, operación masiva, filtros, preview y respuestas de catálogos.
4. Asignar un único propietario de `src/lib/db/types.ts` y de cada migración. El coordinador conserva `src/app/page.tsx`, `page.module.css` y `page.test.tsx` durante todo el trabajo.
5. Registrar una ejecución base de checks en el entorno de desarrollo para distinguir fallos previos de regresiones.

### Fase 1: cuatro frentes simultáneos

| Responsable | Trabajo | Archivos propios / límites |
| --- | --- | --- |
| Coordinador | Login y contratos compartidos; resolver decisiones y preparar integración. | Login, tipos compartidos y pantalla principal. |
| Subagente A: datos y API | Esquema tags, RPCs, revisiones, filtros de servidor, exportación, endpoints tags/organizaciones. | Migraciones, `query.ts`, `repository.ts`, `save.ts`, `export.ts` y rutas asignadas. Es el único autor de SQL de esta fase. |
| Subagente B: importación | Metadatos, tooltip, parser, mapeo tags, payload y preview UI. | `columnMapping.ts`, `importFields.ts`, `excelParser.ts`, `import.ts`, `components/import/`. Entrega a A el contrato SQL y no edita sus migraciones. |
| Subagente C: catálogos y UI | Job Types API/pantalla, TagPicker, acciones masivas, drawer, tabla y filtros visuales; editor de sector si se confirma. | `components/settings/`, componentes de contactos y rutas job-types. Usa contratos acordados con A y no modifica query/repositorio ni page. |

Las UI pueden avanzar contra fixtures de los contratos mientras A implementa persistencia. C desarrolla primero Job Types para entregar una mejora independiente; luego componentes de etiquetas y filtros.

### Fase 2: integración secuencial con verificaciones paralelas

1. Integrar esquema y RPCs en Supabase local. Verificar RLS, atomicidad y compatibilidad con payloads sin etiquetas.
2. Integrar consultas y filtros de servidor; verificar conteo y exportación.
3. El coordinador conecta los componentes en `page.tsx`: carga de opciones, mapeo de datos, selección, refrescos, navegación a Settings e importación.
4. A verifica concurrencia y consultas reales; B verifica preview/importación; C revisa recorridos de UI y accesibilidad. Cada agente reporta resultados y limitaciones concretas.
5. Si se amplían sectores por archivo, integrar esa parte después del contrato de organización, con una migración posterior asignada a A.

### Fase 3: validación conjunta y entrega

Ejecutar los checks finales sobre el mismo árbol integrado y dejar instrucciones de migración/despliegue. El despliegue no forma parte de esta fase de planificación.

**Camino crítico:** contratos → esquema/RPC → importación y filtros reales → integración de página → regresión conjunta. Login, ayuda inicial y Job Types pueden completarse antes y en paralelo. La velocidad no mejora poniendo dos agentes a editar `page.tsx` o la misma función SQL.

## 6. Plan de pruebas

| Área | Pruebas existentes a ampliar / nuevas |
| --- | --- |
| Parser y mapeo | `src/lib/contacts/columnMapping.test.ts`, `src/lib/excelParser.test.ts`; campos obligatorios, nombres alternativos, separadores, duplicados y encabezados Industry ambiguos. |
| Guardado e importación | `src/lib/contacts/save.test.ts`, `save.integration.test.ts`, `import.test.ts`, `import.integration.test.ts`; atomicidad, omisión frente a vacío, reimportación, revisiones y preview sin escrituras. |
| Filtros/exportación | `src/lib/contacts/query.test.ts`, `repository.test.ts`, `export.test.ts`, `src/app/api/contacts/export/route.test.ts`; filtros combinados, paginación, selección y duplicados por múltiples tags. |
| Componentes | Pruebas existentes de ContactDrawer, ContactTable, FilterBar, ImportChangePreview y `src/app/page.test.tsx`; añadir pruebas de operaciones y errores de componentes nuevos con lógica. |
| Catálogos y lote | Tests junto a rutas nuevas; nombres duplicados, IDs inválidos, selección vacía, más de 2.000 IDs, idempotencia y rollback. |
| DB y permisos | Nueva verificación en `supabase/tests/`; anónimo, usuario sin membresía, deshabilitado, operador y administrador. Probar acceso directo/RPC además de API. |
| Navegador | `src/e2e/auth.spec.ts` para reveal; recorridos autenticados de importación, etiquetado entre páginas, filtros y renombrado en `src/e2e/smoke.spec.ts` o specs nuevas. Si se crean specs, ampliar `testMatch` en `playwright.config.ts` para que realmente se ejecuten. |

Comandos de verificación para la implementación, en PowerShell:

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test -- --runInBand
npm.cmd run test:integration
npm.cmd run db:verify
npm.cmd run build
npm.cmd run test:e2e
```

Ejecutar primero las suites del área modificada y luego la validación integrada. Las verificaciones SQL e integración necesitan Supabase local y fixtures; los recorridos autenticados necesitan las credenciales de prueba. Una suite omitida por falta de entorno no cuenta como aprobada. Respetar los umbrales de cobertura de CI sin añadir pruebas que solo reproduzcan detalles internos de implementación.

## 7. Riesgos y salida de cada entrega

- **Cambios locales amplios:** preservar la base actual de membresía, consentimiento, guardado transaccional y preview. Este plan no sustituye el plan de remediación existente.
- **Archivo central compartido:** integración exclusiva del coordinador; entregar componentes con props acordadas.
- **Etiquetas y concurrencia:** actualizar revisión por cambios efectivos, mantener compatibilidad de payloads antiguos y probar carreras entre edición/importación/lote.
- **Organización compartida:** cambiar sector afecta a varias personas; mostrarlo en UI y preview cuando corresponda.
- **Datos y límites:** consultas paginadas, conteos sin duplicación y ninguna truncación silenciosa de opciones o selección.
- **Industry/Job Type:** la terminología debe resolverse antes de cambiar aliases; nunca migrar valores existentes por inferencia.
- **Segmentos guardados:** si se piden grupos reutilizables por etiquetas, abrir una tarea explícita para `src/lib/marketing/segmentCriteria.ts`, `segments.ts`, `facets.ts`, el editor de segmentos, `segment_contacts()` y sus pruebas. Mantener intactas las puertas de consentimiento y archivado. Ese trabajo no está incluido en el filtro básico de contactos.

Cada entrega debe incluir funcionalidad conectada, pruebas relevantes, archivos modificados, documentación actualizada y limitaciones. Para una futura publicación: aplicar primero migraciones aditivas compatibles, después desplegar aplicación y ejecutar smoke tests; no eliminar las tablas nuevas como estrategia automática de rollback.

## 8. Fase 0 completada: decisiones y contratos fijados (29/09/2026)

### Decisiones

- **Grupos:** selección múltiple **y** grupos persistentes. Los grupos persistentes se implementan como segmentos con criterio de etiquetas (`segmentCriteria.ts`, `segments.ts`, `facets.ts`, editor de segmentos, `segment_contacts()`), en una fase posterior a la base de etiquetas, sin tocar las puertas de consentimiento y archivado.
- **Industry:** sector de la organización (`organisations.industry`), separado de Job Type, editable en Settings y con filtro propio. En importación, los encabezados `industry`/`sector` pasan a ser ambiguos (no se asignan automáticamente a Job Type).

### Tipos compartidos (`src/lib/db/types.ts`)

`TagRow`, `ContactTagRow`, `TAG_NAME_MAX_LENGTH = 80`, `MAX_TAGS_PER_CONTACT = 50`, `TAG_SEPARATOR = ';'`, `ApplyContactTagsResult`, `ImportContactPayloadRow.tag_names`, `ImportPreview.tags_only_changed | tags_assigned | tags_created`, RPC `apply_contact_tags`.

### Filtros de contactos (URL / `ContactFilters`)

| Param | Campo | Semántica |
| --- | --- | --- |
| `tagIds=a,b` | `tagIds: string[] \| null` | Cualquiera de las etiquetas (EXISTS). Máx. 50 IDs; formato UUID. |
| `organisationId=x` | `organisationId: string \| null` | Igualdad por ID. |
| `industry=Health` | `industry: string \| null` | Igualdad sin mayúsculas ni espacios extremos sobre `organisations.industry`. |

AND entre familias. Aplican igual a listado, conteo y exportación. Cada contacto aparece una vez.

### API

Todas con `requireSessionOr401` y el envoltorio de `src/lib/api/responses.ts`.

| Endpoint | Entrada | Salida |
| --- | --- | --- |
| `GET /api/tags?q=&page=&pageSize=` | | `{ tags: {id,name}[], total, page, pageSize, hasMore }` |
| `POST /api/tags` | `{ name }` | 201 `{ tag, created: true }`; si ya existe (normalizado) 200 `{ tag, created: false }`; 400 nombre inválido |
| `POST /api/contacts/tags` | `{ contactIds, tagIds, operation: 'add'\|'remove' }` | 200 `{ updated }`; 400 lista vacía, >2.000 contactos, >50 tags o IDs mal formados; 409 selección obsoleta (contacto inexistente/archivado o etiqueta inexistente) |
| `GET /api/job-types?q=&page=&pageSize=` | | `{ jobTypes: {id,name}[], total, page, pageSize, hasMore }` |
| `POST /api/job-types` | `{ name }` | 201 `{ jobType }`; 409 duplicado |
| `PATCH /api/job-types/[id]` | `{ name }` | 200 `{ jobType }`; 404; 409 duplicado |
| `GET /api/organisations?q=&page=&pageSize=` | | `{ organisations: {id,name,industry}[], total, page, pageSize, hasMore }` |
| `GET /api/organisations?facet=industry&q=` | | `{ industries: string[] }` (distintos, ordenados, máx. 200) |
| `PATCH /api/organisations/[id]` | `{ industry: string \| null, expectedIndustry: string \| null }` | 200 `{ organisation }`; 404; 409 si el valor actual ≠ `expectedIndustry` |

### Guardado de contacto

`ContactSaveInput.tagIds?: string[]`. Ausente ⇒ conserva etiquetas; `[]` ⇒ las elimina. `save_contact` gana `p_tags uuid[] default null` (null = conservar) en una migración nueva; sigue siendo una única transacción con `expectedRevision`. La respuesta de contactos (`fetchContacts`) incluye `tags: {id,name}[]` por fila; `TableContact.tags?: {id:string;name:string}[]`.

### Propiedad de archivos

- **Coordinador:** login, `page.tsx`, `page.module.css`, `page.test.tsx`, este documento.
- **A (datos/API):** `src/lib/db/types.ts` (desde ahora), `supabase/migrations/2026100600*`, `supabase/tests/`, `query.ts`, `repository.ts`, `save.ts`, `saveHandler.ts`, `export.ts`, `tags.ts`, `organisations.ts`, rutas `api/tags`, `api/contacts/tags`, `api/organisations`, `api/contacts/*`.
- **B (importación):** `columnMapping.ts`, `importFields.ts`, `excelParser.ts`, `import.ts`, `components/import/`, `docs/IMPORTS.md`. Entrega a A el contrato SQL de `tag_names`.
- **C (catálogos/UI):** `components/settings/` (nuevos), `components/contacts/` (FilterBar, TagPicker, BulkTagActions, OrganisationPicker), `ContactDrawer.tsx`, `ContactTable.tsx` y sus CSS/tests, rutas `api/job-types`, `src/lib/contacts/jobTypes.ts`.

## 9. Resultado de la implementación (29/09/2026)

**Entregado:** A (ayuda de columnas), B (etiquetas: modelo, RPCs, guardado, lote, importación, filtros, exportación), C (Job Types en Settings y modal sobre el drawer), D (filtros de organización e Industry; edición del sector en Settings), E (mostrar/ocultar contraseña).

**Migraciones nuevas:** `20261006000000_contact_tags.sql` (tablas, RLS, `create_tag`, `apply_contact_tags`, `save_contact` con `p_tags`, `organisations.industry_key` + `organisation_industries`) y `20261006010000_import_contact_tags.sql` (`tag_names` en staging/preview/import). Aplicar antes de desplegar la aplicación.

**Desviaciones del contrato de la sección 8:** CRM07 lleva hint `stale_tags` (→ 409) o `tag_limit` (→ 400); un no miembro recibe 403; guardar con una etiqueta borrada devuelve conflicto. `tagIds` mal formados se descartan; más de 50 se recortan a 50; `organisationId` no UUID e `industry` > 120 caracteres se ignoran. El token del preview también cubre qué etiquetas existen en el catálogo. Las etiquetas comunes de importación se introducen por nombre (no con `TagPicker`) para no crear etiquetas antes de confirmar la importación.

**Verificación ejecutada:** `tsc` limpio; lint 0 errores; Jest 2258 aprobadas (4 fallos preexistentes en `runJobs.test.ts`, presentes en la línea base); `next build` correcto; `src/e2e/auth.spec.ts` 93 aprobadas en 3 navegadores. Migraciones reproducidas en PGlite con `verify_20261006000000` aprobado.

**Sin verificar (requiere Docker + Supabase local):** `npm run db:verify`, `npm run test:integration` (incluido `tags.integration.test.ts`, que comprueba que el filtro por varias etiquetas no duplica contactos) y el comportamiento real de los embeds `!inner` de PostgREST. Recorridos E2E autenticados de etiquetas/filtros/renombrado: pendientes, necesitan credenciales de prueba.

**Pendiente de alcance:** grupos persistentes por etiquetas (criterio de etiquetas en segmentos), según la sección 7.

**Deuda:** `ContactDrawer.tsx` (≈820 líneas) y `page.tsx` superan el límite de 800 líneas.
