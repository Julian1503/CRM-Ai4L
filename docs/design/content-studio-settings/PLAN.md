# Propuesta UI/UX: Content Studio y Settings

Fecha: 2026-10-10. Estado: rediseño implementado localmente; pendiente de aplicar la migración de base de datos en los entornos desplegados.

## 1. Decisión recomendada

Settings: navegación local vertical con seis categorías y un solo panel visible. Perfil de marca dividido en cuatro pestañas internas. Content Studio: composición de estudio editorial con brief y canales en paralelo, seguida de un espacio de edición con vista previa persistente. Mantener la identidad clara y celeste implementada en el CRM.

La propuesta cubre ambas superficies completas, desktop y móvil. Incluye arquitectura de información, composición, interacciones, estados y secuencia de implementación. Las imágenes son exploraciones de dirección, no especificaciones exactas de controles, textos o contratos.

Dirección visual confirmada por el usuario: rediseño profundo dentro de la identidad actual, composición A con el selector compacto de B. La alternativa B introduce creación guiada por pasos y queda solo como exploración. La implementación conserva el esquema de vistas y los contratos de publicación existentes.

## 2. Diagnóstico basado en el repositorio

Revisión de componentes, CSS, contratos y documentación local. La inspección visual de la implementación se hizo con datos simulados porque la sesión autenticada local había caducado. No se midió la altura con datos reales del producto.

| Evidencia | Consecuencia | Respuesta de diseño |
| --- | --- | --- |
| `src/app/page.tsx` monta OperationsPanel, Database Config, EmailOctopusSettings, SocialConnectionsSettings, BrandProfileSettings, JobTypesSettings y OrganisationSettings en una sola columna | Siete bloques de tareas distintas compiten en una página extensa | Navegación por categoría; montar solo la categoría activa |
| La columna izquierda de Settings es texto introductorio estático | Consume espacio que puede servir para orientación y acceso directo | Reemplazarla por navegación local |
| El encabezado de Settings habla principalmente de endpoints y credenciales | No representa marca, catálogos y operaciones | Encabezado corto orientado a las tareas reales |
| BrandForm muestra todos los campos, hechos y reglas de cuatro canales simultáneamente | El perfil de marca seguirá siendo largo aunque se aísle en una categoría | Cuatro pestañas internas y edición progresiva de reglas |
| BriefForm presenta campos con peso similar y una fila de checkboxes para canales | Falta jerarquía entre idea, contexto y destinos | Topic protagonista, canales visuales y contexto secundario plegable |
| ContentStudioView ya tiene Create, Library, Review y Publications | Existe una arquitectura útil | Reforzar esas cuatro áreas y la navegación de detalle |
| ItemDetail apila todos los canales, variantes, recursos e historial | La longitud crece con cada variante | Selección de canal y variante, editor central y vista previa |
| VariantCard expone muchas acciones al mismo nivel y oculta la vista previa tras un botón | Cuesta reconocer el siguiente paso | Acción principal contextual y acciones secundarias agrupadas |
| El resumen de biblioteca contiene contadores y fechas, pero no miniatura | Una biblioteca visual puede requerir datos nuevos | Usar filas editoriales con información real; miniaturas como ampliación explícita |
| `DESIGN.md` mezcla un frontmatter celeste con descripción oscura/índigo; `globals.css` usa celeste claro | Riesgo de construir una identidad incoherente | Tomar los tokens implementados como base y reconciliar documentación durante la implementación |

## 3. Dirección visual compartida

Escena de uso: una persona del equipo comercial o de contenido trabaja durante el día, alternando gestión de contactos y preparación de publicaciones en un portátil; necesita leer formularios y revisar textos durante sesiones largas. Se conserva el tema claro actual.

- Fondo de aplicación celeste muy claro y superficies blancas. Celeste reservado a selección y jerarquía interactiva; estados con texto e icono además de color.
- Outfit en títulos y Plus Jakarta Sans en interfaz, respetando las fuentes existentes. Títulos de página alrededor de 28–32 px; secciones 18–22 px; controles y cuerpo 14–16 px.
- Espaciado de 8/16/24/32 px, líneas divisorias finas, radios coherentes de 8–14 px. Reducir contenedores anidados y dobles marcos en estas superficies.
- Acción primaria con tono suficientemente oscuro para texto blanco. El celeste actual no debe asumirse accesible para todas las combinaciones: medir contraste antes de fijar nuevos tokens.
- Movimiento de 150–200 ms para selección, expansión y feedback; alternativa inmediata con movimiento reducido.
- La identidad extraordinaria de Studio proviene de su composición, contenido visible, vistas previas cuidadas y precisión de estados.

Anclas concretas de diseño: tokens de `globals.css`, cuatro áreas de `ContentStudioView` y presentación por plataforma de `SocialPreview`. No se propone una nueva marca ni una nueva biblioteca visual global.

## 4. Settings

### Arquitectura

| Categoría visible | Contenido y comportamiento |
| --- | --- |
| Overview | Resumen operativo existente, incidencias reales y accesos a categorías. Indicadores ampliados y diagnóstico detallado bajo expansión |
| Brand profile | Voz y audiencia, hechos aprobados, reglas por canal y dirección visual/enlaces |
| Connections | EmailOctopus y cuentas sociales; filas compactas por integración y configuración al seleccionar una |
| Job types | Catálogo existente, búsqueda, alta y renombrado; conservar paginación |
| Organisations | Búsqueda y edición de sector por organización; conservar paginación y resolución de conflictos |
| System | Estado de configuración de Supabase; datos de entorno de solo lectura y detalles técnicos plegables |

Elegir navegación vertical sobre seis tabs horizontales porque los nombres son largos, el espacio local ya existe y facilita una futura categoría sin comprimir las etiquetas. Los enlaces representan destinos y usan `aria-current`; las pestañas dentro del formulario sí siguen el patrón tablist/tab/tabpanel.

En pantallas amplias: navegación local de 200–224 px y panel flexible. La navegación global del CRM conserva su jerarquía. En anchuras intermedias, convertir la navegación local en selector para evitar tres columnas estrechas. En móvil: selector de categoría etiquetado, encabezado y un panel en una columna.

### Perfil de marca

Cuatro pestañas visibles:

1. **Voice & audience:** nombre, región, tono y audiencia.
2. **Approved facts:** lista compacta de hechos existentes y edición inline del hecho activo; altas sin mostrar formularios vacíos por defecto.
3. **Channel rules:** elegir Facebook, Instagram, LinkedIn o Email y editar CTA/estructura de ese canal. Hashtag seeds en este panel, aclarando que son globales.
4. **Visuals & links:** dirección de imagen y orígenes de enlaces permitidos, con ayuda contextual.

Un único borrador del perfil en el contenedor mantiene los cambios al alternar pestañas. `Save brand profile` guarda el perfil completo mediante el contrato actual. Mostrar qué pestañas tienen cambios o errores; al fallar validación, abrir la pestaña del primer error y enfocar el campo.

Barra de acciones sticky dentro del área de contenido solo cuando hay cambios: estado, Discard y Save brand profile. No mostrar «Saved» hasta recibir confirmación del servidor. La barra no oculta el último campo ni el foco con teclado o zoom.

Cambiar de categoría conserva el borrador en memoria durante la sesión de Settings. Salir con cambios ofrece guardar, descartar o continuar editando. Las credenciales se mantienen solo en memoria y se limpian al guardar, descartar o cerrar; no persistirlas en URL o almacenamiento del navegador.

### Conexiones y permisos

Mostrar nombre del proveedor/cuenta, estado real y una acción contextual. Desconectado, reconexión requerida y no habilitado son estados diferentes. Error al consultar significa estado desconocido, no desconectado.

La configuración de EmailOctopus se expande al solicitarla. Las cuentas sociales conectadas se muestran como filas con identidad y estado. Solo administradores pueden conectar/desconectar o editar marca; la presentación de permisos debe corresponder a la autorización real del servidor.

En System, sustituir campos que parecen editables por valores de solo lectura y etiquetas Configured/Not configured. Detalles de variables dentro de un disclosure técnico. No añadir botones de guardar para valores de entorno.

### Enlaces y regreso al trabajo

Extender el esquema de navegación actual `?view=` con destinos explícitos, por ejemplo `?view=settings&section=connections` y `?view=settings&section=brand&panel=voice`. Son URLs propuestas, no rutas existentes.

`Connections` desde Studio abre directamente Connections. Un acceso a marca abre Brand profile. Volver a Studio restaura sección, pieza y variante cuando corresponda. Conservar los parámetros de retorno OAuth y procesarlos aunque la sección inicial sea otra; no reemplazar indiscriminadamente la query.

Navegación atrás/adelante debe actualizar la categoría. Valores desconocidos vuelven a Overview. Cargar solo recursos del panel activo; el estado de borrador vive fuera del panel desmontable.

### Boceto

```text
Settings
Manage your brand, connections and CRM configuration

Overview         | Brand profile
Brand profile    | Voice & audience · Approved facts · Channel rules · Visuals & links
Connections      |
Job types        | Brand name                 Region
Organisations    | Tone of voice
System           | Audience
                 |
                 | Unsaved changes                  Discard  Save brand profile
```

Meta: ver categoría, título y comienzo del formulario sin scroll; configuraciones cortas dentro de aproximadamente un viewport desktop, formularios habituales dentro de uno o dos. Las listas largas siguen usando paginación y scroll natural. No imponer alturas fijas que corten texto o generen varios scrolls anidados.

## 5. Content Studio

### Navegación general

Conservar **Create / Library / Review / Publications**, con indicador activo preciso y accesos contextuales a marca/conexiones. Los contadores de Review, si se añaden, deben ser totales reales proporcionados por el servidor; no derivarlos de una sola página de resultados.

La pieza abierta tiene breadcrumb a su origen. Al volver se restauran búsqueda, filtros y página. El borrador de Create sobrevive a cambios de sección dentro de Studio. La persistencia a través de recarga requiere una decisión adicional de almacenamiento y no se promete en la primera fase.

### Create: brief enfocado y destinos visuales

Escritorio amplio: área de brief de aproximadamente dos tercios y configuración lateral de un tercio. Mantener una anchura legible y evitar un formulario estrecho dentro de espacio vacío.

Orden de contenido:

1. Topic como campo principal, con una indicación concreta del contenido esperado.
2. Title obligatorio, hasta 200 caracteres según validación actual.
3. Audience y Objective en pareja; conservar entrada libre.
4. Supporting context plegable: Reference URL, Notes y Source facts. Mostrar un resumen de contexto agregado cuando esté cerrado. Abrir automáticamente si contiene un error.
5. Configuración lateral: canales, variantes por canal y resumen de marca real.

### Selector de canales

Cuatro tiles compactos, cada uno con icono de plataforma, nombre, descripción corta y check de selección. Composición 2×2 en el lateral; también 2×2 en móvil si el texto cabe cómodamente.

Toda la superficie del tile selecciona; el checkbox accesible conserva su semántica, navegación y estado. No usar radio buttons: se pueden seleccionar varios canales. Diferenciar default, hover, foco, seleccionado y disabled con más de un recurso visual.

Estado de conexión es información secundaria. Una cuenta desconectada permite generar; el mensaje correcto es «Connect before publishing». Abrir conexiones con una acción separada fuera del label interactivo para evitar controles anidados. Si hay múltiples cuentas, indicar su cantidad o un resumen; la cuenta de publicación se elige en el flujo de publicar.

Email es un destino de contenido con entrega posterior mediante campañas/exportación, según permisos y flags reales. No presentarlo como publicación social instantánea.

Variantes por canal: control segmentado 1 / 2 / 3 con semántica de selección única. Resumen derivado de la selección: «2 channels · 4 variants». No mostrar estimaciones de tiempo, coste ni porcentajes sin información del motor.

Conservar inicialmente los valores por defecto existentes: Facebook y LinkedIn, una variante por canal. Las selecciones de las imágenes son datos de ejemplo.

Acción primaria **Create and generate**, con resumen de destinos. Si la pieza se crea pero falla la generación, conservar el estado bloqueado y ofrecer **Retry generation** y **Open saved item**, utilizando la idempotencia existente.

### Espacio de edición y revisión

```text
Library / October AI workshops              Pending review

Facebook · Instagram · LinkedIn · Email

Variants        | Editor                         | Preview
Practical       | Body                           | Plataforma y cuenta
Story-led       | CTA / Link / Hashtags          | Texto e imagen actuales
Direct          | Media                          | Avisos de representación
                |                                |
                | Save revision                  | Approve revision

Brief · Media · History
```

Los nombres de variantes del boceto son ilustrativos; utilizar los estilos recibidos del servidor.

Mostrar un canal activo y una variante activa, con estado y número de revisión. En desktop ancho, lista compacta de variantes, editor y vista previa. Si el ancho útil no alcanza, convertir la lista en selector superior antes de comprimir editor/preview. En móvil: selector de canal, selector de variante y tabs Edit/Preview.

La vista previa consume el borrador actual del editor, sin necesidad de guardarlo. Indicar «Unsaved preview» mientras difiere de la revisión persistida; aprobar/publicar siempre se refiere a la revisión guardada. Reutilizar `SocialPreview` y el renderizador de email existente donde el contrato lo permita. No representar controles sociales como si fueran funcionales.

Jerarquía contextual:

| Estado | Acción destacada | Otras acciones |
| --- | --- | --- |
| Editando | Save revision | Cancel; vista previa del borrador |
| Revisión pendiente | Approve revision | Edit, Reject, Regenerate |
| Aprobada, canal social | Publish | Edit; al guardar una nueva revisión se vuelve a requerir revisión |
| Email | Create email draft o Export según capacidades | Revisión y edición según contrato vigente |
| Archivada | Restore donde exista soporte | Historial conservado |

Duplicate, Copy text y Archive dentro de un menú secundario accesible. Mantener las acciones frecuentes visibles. No combinar aprobación y publicación: el diálogo de publicar mantiene cuenta, revisión, preflight y confirmación existentes.

Media y History pasan a paneles del detalle, evitando apilarlos después de todas las variantes. Usar miniaturas de recursos reales, selección visible, orden y estados processing/ready/rejected. Las imágenes siguen agregándose una vez creada la pieza, conforme al flujo actual.

### Library, Review y Publications

- **Library:** filas editoriales con título dominante, iconos de canales, variantes/aprobadas/pendientes, trabajo activo y última actualización. Búsqueda y archivadas en una barra compacta; conservar paginación.
- **Review:** cola enfocada en pendientes, abrir directamente una variante pendiente y ofrecer siguiente elemento cuando haya datos suficientes. El código actual filtra pendientes sobre una página de elementos activos y omite paginación en Review; corregir la consulta/paginación antes de prometer una cola completa.
- **Publications:** historial con canal, cuenta, estado, fecha y acciones reales. `uncertain` tiene explicación y resolución humana; no presentarlo como fallo ordinario ni ofrecer reintento ciego.
- **Vacíos:** distinguir aún sin contenido, ninguna coincidencia, sin pendientes y sin publicaciones. Cada estado ofrece la siguiente acción útil correspondiente.

Una biblioteca con imágenes de portada queda como ampliación: `ContentItemSummary` no contiene miniatura. Si se incorpora, extender el endpoint con un resumen seguro de asset y evitar una consulta adicional por fila.

## 6. Estados y accesibilidad

| Situación | Respuesta prevista |
| --- | --- |
| Carga inicial | Skeleton con la geometría del panel; `aria-busy` |
| Actualización | Mantener contenido anterior y señalar actualización |
| Fallo de lectura | Error local con Retry, sin vaciar todo el workspace |
| Generación en cola/en marcha | Etapa real y resultados disponibles; sin progreso porcentual inventado |
| Generación parcial o fallida | Conservar resultados y explicar qué se puede reintentar |
| Error de formulario | Mensaje junto al campo, resumen si hay varios y foco en el primero |
| Conflicto de revisión | Preservar borrador y presentar revisión más reciente; mantener protección existente |
| Revisión bloqueada | Motivo visible y acceso a editar antes de aprobar |
| Publicación uncertain | Explicación de resultado desconocido y revisión humana |
| Permiso insuficiente | Estado de solo lectura y razón visible |
| Cambios sin guardar | Indicador, conservación dentro de la superficie y salida controlada |

Contraste objetivo AA: 4.5:1 para texto normal, 3:1 para texto grande y elementos relevantes de interfaz. Teclado completo, foco visible, etiquetas permanentes y targets táctiles de aproximadamente 44 px. Tabs con flechas y Home/End; links de navegación con comportamiento estándar. Menús y diálogos con foco administrado y retorno al disparador. Mensajes de guardado con `role=status`; errores urgentes con `role=alert`.

Comprobar 390, 768, 1024 y 1440 px, zoom al 200%, textos largos y navegación móvil. Usar scroll del documento cuando sea necesario; no esconder campos para conseguir una altura artificialmente corta.

## 7. Implementación

Las seis fases se aplicaron en la copia local. Settings usa categorías y subpestañas de marca; Studio tiene selector visual de canales, editor con vista previa y navegación por canal/variante. La cola Review consulta pendientes en el servidor mediante `content_pending_review_items` y pagina resultados. La migración `supabase/migrations/20261010020000_content_pending_review_queue.sql` debe aplicarse antes de usar esa cola en otros entornos.

La revisión de compilación, tipos y lint terminó sin errores. No se ejecutaron tests de aplicación. La revisión visual cubrió escritorio y móvil con respuestas simuladas; queda pendiente validar el flujo con una sesión autenticada y datos reales.

| Fase | Entrega | Archivos y dependencias | Condición de cierre |
| --- | --- | --- | --- |
| 1 | Settings por categorías | Extraer `SettingsView` de `src/app/page.tsx`; nuevo shell, navegación y sincronización URL | Un panel activo, acceso directo desde Studio, atrás/adelante y retorno correctos |
| 2 | Marca y conexiones compactas | `BrandProfileSettings`, `SocialConnectionsSettings`, `EmailOctopusSettings`, `OperationsPanel`; reutilizar catálogos | Cuatro subpaneles de marca, borrador estable, errores localizables, permisos reales |
| 3 | Create y canales | `BriefForm`, `ContentStudioView`, `ContentStudio.module.css`; nuevo `ChannelSelector` y estado compartido del brief | Selección múltiple visual, resumen correcto, generación y recuperación conservadas |
| 4 | Editor y preview | `ItemDetail`, `VariantCard`, `VariantEditor`, `SocialPreview`, `AssetLibrary`, `Variant.module.css` | Canal/variante activos, preview del borrador, revisión guardada inequívoca |
| 5 | Biblioteca, revisión y publicaciones | `ItemLibrary`, `PublicationHistory`; ampliar consulta de pendientes si es necesario | Ningún pendiente inaccesible por filtro local; navegación y paginación consistentes |
| 6 | Ajuste final y verificación | CSS compartido, pruebas existentes, documentación visual | Responsive, teclado, contraste y regresiones cubiertos |

Componentes nuevos propuestos: `SettingsView`, `SettingsNavigation`, `SettingsSaveBar`, `ChannelSelector`, `StudioWorkspace`, `VariantNavigator`. Extraer solo los patrones realmente compartidos; conservar API, modelos y funciones de mutación existentes siempre que el cambio sea de presentación.

Antes de escribir código Next.js, leer las guías pertinentes instaladas en `node_modules/next/dist/docs/`, especialmente navegación y componentes cliente. La aplicación actual utiliza estado de vista y parámetros query; no es necesario migrar todo el CRM a rutas nuevas para este trabajo.

La implementación partió de cambios locales ajenos en `src/app/page.tsx` y componentes compartidos, y los conservó. El usuario también autorizó actualizar la skill Impeccable.

### Dependencias que no deben ocultarse

- Borradores persistentes entre paneles requieren elevar el estado antes de desmontar los formularios.
- Navegación de Settings necesita un destino explícito en el callback actual `onOpenSettings`, que hoy solo cambia la vista.
- Vista previa durante edición requiere compartir el draft de `VariantEditor` y resolver los assets sin guardar una revisión.
- Review completa y contador global pueden requerir cambios en consulta/endpoint; no fingirlos con datos de una página.
- Miniaturas en Library requieren extensión del resumen; se pueden posponer sin impedir el rediseño principal.
- Un selector más atractivo no cambia los permisos, los flags ni la necesidad de aprobar una revisión antes de publicar.

### Verificación prevista para la implementación

Adaptar pruebas existentes de BriefForm, ContentStudioView, ItemDetail, VariantEditor y Settings. Añadir cobertura significativa para: preservar borradores al navegar, enlace directo y retorno OAuth, preselección/selección múltiple, recuperación tras creación parcial, preview sin guardado, conflicto de revisión, publicación de revisión aprobada y paginación de pendientes. Usar mocks para proveedores. No publicar ni enviar correos reales para comprobar estilos.

Prueba visual manual en navegador y accesibilidad de ambas superficies. Medir altura antes/después con igual viewport y datos. Aceptar Settings cuando cada tarea se alcanza desde su categoría sin atravesar otras secciones. Aceptar Studio cuando se puede crear, editar, revisar y llegar a publicar reconociendo canal, variante y revisión activos en todo momento.

No se ejecutaron tests de aplicación en esta implementación.

## 8. Referencias visuales y límites de las imágenes

- `content-studio-a.png`: exploración A, brief y configuración en paralelo.
- `content-studio-b.png`: exploración B, creación guiada y selector horizontal compacto.
- `settings.png`: categoría local y subpestañas del perfil de marca.
- `PROMPTS.md`: prompts completos utilizados con la herramienta nativa de generación.

Recomendación: A para la composición, compactación de tiles inspirada en B, sin obligar al asistente de tres pasos. Settings sigue la composición de su referencia.

Correcciones normativas frente a los mockups: Title es obligatorio y su máximo actual es 200; no hay un límite de Topic de 500 derivado del código revisado; conectar cuentas no es requisito para generar; Audience, Objective y Region conservan el tipo de entrada permitido por sus contratos; nombres, cuentas y cifras de ejemplo no son datos reales. La imagen de Settings introduce franjas laterales decorativas: implementar selección con fondo y borde completo fino. Las imágenes no autorizan cambiar la navegación global, logo o perfil de usuario. Usar iconos reales del sistema o recursos oficiales en implementación, no recortes del raster.

Referencias de skill útiles en implementación: `impeccable/reference/product.md`, `layout.md`, `clarify.md`, `harden.md`, `adapt.md`, `polish.md` y `audit.md`.
