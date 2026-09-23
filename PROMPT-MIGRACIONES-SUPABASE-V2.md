# PROMPT V2 PARA CHATGPT — Respuesta a tus hallazgos + modelo de usuarios, módulos y tags

> Uso: pegalo como respuesta en el MISMO chat donde ChatGPT ya leyó las migraciones. Ya incluye el seed (catálogo de permisos, roles y taxonomías), así que no hace falta adjuntar nada más.

---

Gracias por la revisión. Respondo a tus puntos, agrego reglas nuevas del modelo de usuarios y te paso el seed. Con esto ya podés generar todo. **Todo en español rioplatense; no ejecutes nada.**

## A. Respuesta a tus hallazgos

1. **Seed de roles y permisos**: te lo paso abajo (sección F). Es la fuente real (`lib/permissions/catalog.ts` + `scripts/seed.ts`). El archivo TypeScript sigue siendo la fuente de verdad en el CRM; por eso, además del SQL, quiero que me des **la lista exacta de permisos/roles/módulos nuevos** en formato `{ key, description }` para pegarla en el catálogo, y que el SQL de seed sea **idempotente** (`ON CONFLICT DO UPDATE`/`DO NOTHING`) y espeje ese catálogo.
2. **Asociaciones, reuniones y formularios sin unidad propietaria**: **de acuerdo con tu propuesta.** Agregales `owner_organization_id uuid NOT NULL references organizations(id) on delete restrict` (la base está vacía, no hay datos que migrar) con índice. Su acceso sigue la misma jerarquía de alcances. Formularios públicos: el destino organizativo lo fija el servidor al configurar el formulario (`forms.owner_organization_id`); quien completa el formulario público **no puede elegir área**. Las personas que se crean desde un formulario heredan esa unidad como repartición inicial.
3. **`people.organization_id` nulo**: de acuerdo. Las altas siguen pudiendo dejarlo nulo (**pendiente de clasificación**), esas personas **no aparecen a usuarios con alcance limitado** (sí al MASTER_GLOBAL). `transfer_person` **rechaza** personas sin repartición: asignar la repartición inicial es otra operación → creá una función `assign_initial_organization(person_id, organization_id, actor_user_id)` que solo funcione cuando es nulo y que quede registrada en una tabla histórica (podés usar `person_organization_transfers` con `from_organization_id` nulo, o una tabla aparte; decidí y justificá, pero el historial no se edita ni se borra).
4. **MASTER_GLOBAL**: **accede a todas las unidades sin asignaciones individuales** y queda exceptuado de tener alcances. Las funciones (`transfer_person`, etc.) deben detectarlo por su rol en la base (`users.role_id → roles.key = 'MASTER_GLOBAL'`), no por un parámetro que mande el cliente. Cualquier otro usuario requiere alcances explícitos y activos.
5. **`meeting_attendance`**: de acuerdo. Permitir UPDATE (correcciones) exigiendo `correction_reason` y `registered_by` no nulos cuando `method = 'manual'` o cuando se corrige, y **bloquear DELETE** con trigger. Sumá un trigger o constraint que impida modificar `meeting_id`/`person_id` de una asistencia existente.
6. **RLS y pruebas de aislamiento**: de acuerdo. En tus verificaciones distinguí (a) pruebas SQL de privilegios (`anon` no lee, `sutecba_app` no borra `audit_logs`), y (b) una **lista de pruebas de aislamiento para la capa servidor** (las escribo yo en TypeScript). No las presentes como demostración por RLS.
7. **Importaciones**: agregá la estrategia entre lotes: el archivo se registra **una sola vez por hash de contenido** (`import_files.content_hash` único global), un nuevo lote puede **referenciar** un archivo ya existente; `import_rows` conserva **todas** las filas del original incluidas las repetidas (único por `(file_id, sheet, row_number)`, más el `row_hash` **sin** restricción única global); la **aplicación** es idempotente por fila (`import_entity_links` único por `(import_row_id, entity_type)`), de modo que reimportar no crea personas duplicadas. Las filas idénticas dentro del mismo archivo se marcan como repetidas, no se descartan.
8. **Búsqueda**: de acuerdo, **no agregues wrapper de `unaccent`** ni índices nuevos de búsqueda. Solo confirmá que `create extension pg_trgm/unaccent` funciona en Supabase (esquema `extensions`) y qué implica para búsquedas futuras.

## B. Modelo de usuarios (similar a otro CRM de gestión territorial)

Tres tipos de usuario, definidos por **rol (acciones) + alcances (registros)**:

| Tipo | Cómo se modela |
|---|---|
| **Master global** | Rol `MASTER_GLOBAL`. Ve y hace todo, en todas las unidades y módulos. Sin alcances asignados. |
| **Usuario de área** | Un rol de acciones (p. ej. ADMIN/OPERADOR/…) + alcance sobre una unidad de nivel superior con `include_descendants = true`. Accede a la unidad y a las reparticiones dependientes. |
| **Usuario de repartición** | Un rol de acciones + alcance sobre una repartición con `include_descendants = false` (o una hoja). Accede solo a esa. |

Un usuario puede tener varios alcances.

**Creación delegada de usuarios (regla clave, riesgo de escalada de privilegios):** los usuarios de área y de repartición **pueden crear usuarios nuevos** (permiso nuevo `users.manage_scoped`, distinto de `users.manage`, que queda para el master). Restricciones que deben quedar garantizadas **en base de datos donde sea posible** (función SQL `create_scoped_user_checks(...)` o triggers) y documentadas para que las repita el servidor:

- Solo puede otorgar alcances **contenidos en sus propios alcances** (unidad igual o descendiente de uno de los suyos; alguien con alcance de repartición no puede dar alcance de área).
- Solo puede asignar **módulos que él mismo tiene habilitados**.
- Solo puede asignar **roles cuyos permisos sean un subconjunto de los suyos** (nunca más permisos que los propios).
- **Nunca** puede crear o editar un `MASTER_GLOBAL`, ni modificar sus propios alcances, módulos o rol.
- Solo ve y administra usuarios cuyos alcances estén **completamente dentro** de los suyos. `users.created_by` ya existe.
- Toda alta, cambio de alcance/módulo y desactivación queda en `audit_logs`. Los alcances y módulos se **revocan con `revoked_at`**, no se borran.
- Al cambiar alcances o módulos de un usuario se debe incrementar `users.permissions_version` (invalida sus sesiones de inmediato). Proveé un trigger o función que lo haga.

## C. Módulos visibles por usuario (diferencia respecto del otro CRM)

Al crear un usuario se decide **qué módulos ve**. Diseñá:

- `modules` (catálogo): `key`, `name`, `sort_order`, `active`. Módulos iniciales: `dashboard`, `personas`, `asociaciones`, `reuniones`, `formularios`, `visualizacion`, `interacciones`, `importaciones`, `etiquetas`, `administracion` (usuarios, roles, organismos, campos personalizados).
- `user_modules`: `user_id`, `module_key/id`, `granted_by`, `granted_at`, `revoked_at`, `revoked_by`. Único parcial por (usuario, módulo) activo. Sin borrados.
- Vinculá cada permiso con su módulo (columna `permissions.module_id/module_key` o tabla `module_permissions`; elegí y justificá).
- Regla de acceso efectiva: **usuario activo + módulo habilitado + permiso para la acción + alcance sobre la unidad del registro.** Que el módulo esté habilitado **no otorga** permisos, y un permiso **no funciona** si el módulo está deshabilitado. El master global ve todos los módulos sin filas en `user_modules`.
- Proveé la función `user_enabled_modules(user_id)` y `user_has_module(user_id, module_key)`.
- Aclarar en un comentario que ocultar módulos en el menú **no es el permiso**: el servidor debe comprobarlo en la página y en cada acción (regla R5).

## D. Tags (etiquetas) de personas

Igual que el otro CRM, las personas pueden tener tags. Diseñá:

- `tags`: `id`, `name`, `normalized_name` (minúsculas, sin acentos, espacios normalizados), `category text` (opcional, para agrupar, por ejemplo `PROFESION`, `SITUACION`), `is_controlled boolean` (tags de vocabulario cerrado que solo crea/edita quien tenga `tags.manage`; los libres los puede crear quien tenga `tags.assign` dentro de su alcance), `is_sensitive boolean` (**visible solo con `people.view_sensitive`**, porque una etiqueta puede revelar afiliación u opinión política → dato sensible, Ley 25.326), `owner_organization_id` (nulo = global, solo lo crea el master; no nulo = visible para quienes tengan alcance sobre esa unidad), `active`, `created_by`, `created_at`. Único por `(owner_organization_id, normalized_name)` tratando nulo como valor.
- `person_tags`: `person_id`, `tag_id`, `assigned_by`, `assigned_at`, `removed_at`, `removed_by`. **No se borra**: quitar un tag = `removed_at`. Único parcial por (persona, tag) activo.
- Permisos nuevos: `tags.view`, `tags.assign`, `tags.manage`.
- Índices para filtrar personas por tag y para contar tags por unidad.
- Dejá anotado que el servidor debe aplicar las reglas de visibilidad de tags en listados, filtros, exportaciones y estadísticas (lección aprendida: los datos sensibles se filtraron en pantallas secundarias y hubo que corregirlo).

## E. Migraciones a entregar (renumeradas)

Mantené la numeración desde `0012`, en este orden (ajustá si ves un orden mejor y explicalo):

- `0012` Organizaciones ampliadas, alias, `user_scopes`, funciones de descendientes y de organizaciones accesibles.
- `0013` Catálogo de módulos, `user_modules`, permisos nuevos, funciones de módulos, controles de creación delegada de usuarios y trigger de `permissions_version`.
- `0014` `owner_organization_id` en `associations`, `meetings`, `forms` (+ índices).
- `0015` Traslados de personas (`person_organization_transfers`, `transfer_person`, `assign_initial_organization`, constancia para la repartición de origen).
- `0016` Tags (`tags`, `person_tags`).
- `0017` Interacciones (catálogos, `person_interactions`, `association_interactions`, `interaction_links`).
- `0018` Importaciones (con la estrategia entre lotes de A.7).
- `0019` Seguridad Supabase (rol `sutecba_app`, revocaciones a `anon`/`authenticated`, RLS default-deny con política para `sutecba_app`, `ALTER DEFAULT PRIVILEGES`, guía de cadena de conexión). Contraseña siempre como placeholder `<<CONTRASEÑA_A_DEFINIR>>`.
- `seed_0001.sql` (aparte de las migraciones): roles, permisos (los existentes **más los nuevos**), `role_permissions`, módulos, tipos de organización, tipos de asociación, catálogo de tipos y canales de interacción, y `app_settings` por defecto. Idempotente. Antes de escribirlo, mirá cómo la tabla `app_settings` y las guardas de identidad del sistema están definidas en las migraciones adjuntas; si no está claro, **preguntame**.

Cada migración con su bloque de **verificación** y su **down conservador** (sin borrar datos históricos), y cada una aplicable dentro de una transacción.

**Asignación de permisos por rol**: partí de la tabla actual (abajo), agregá los permisos nuevos (`users.manage_scoped`, `scopes.manage`, `people.transfer`, `people.assign_organization`, `interactions.view/create/edit`, `imports.view/run/review`, `tags.view/assign/manage`) y proponé qué roles los reciben. Recordá que un usuario de área/repartición **no hereda `roles.manage` ni `organizations.manage`**.

## F. Seed actual (fuente: `lib/permissions/catalog.ts` y `scripts/seed.ts`)

### Permisos existentes (30)

```
dashboard.view            Ver el dashboard operativo
visualization.view        Ver el módulo de visualización/análisis
people.view               Ver el listado y la ficha de personas
people.create             Dar de alta personas
people.edit               Editar datos de personas
people.deactivate         Desactivar personas
people.export             Exportar personas a CSV
people.view_sensitive     Ver DNI/teléfono/email sin enmascarar
people.manage_custom_fields  Definir campos personalizados de personas (usados también por Formularios)
organizations.manage      Administrar el catálogo de organismos (tipos y jerarquía)
associations.view         Ver asociaciones y sus miembros
associations.create       Crear asociaciones
associations.edit         Editar asociaciones
associations.deactivate   Desactivar asociaciones
associations.manage_members  Agregar/quitar miembros de una asociación
meetings.view             Ver reuniones
meetings.create           Crear reuniones
meetings.edit             Editar reuniones
meetings.change_status    Cambiar el estado de una reunión (iniciar/finalizar/cancelar)
meetings.manage_invitations  Generar y gestionar invitaciones
meetings.attendance_manual   Registrar/corregir asistencia manualmente
forms.view                Ver formularios y sus respuestas
forms.create              Crear formularios
forms.edit                Editar formularios
forms.publish             Publicar/despublicar/archivar formularios
forms.export_submissions  Exportar respuestas de formularios
forms.review_duplicates   Resolver candidatos a duplicado
users.manage              Crear/editar/desactivar usuarios (no incluye rol MASTER_GLOBAL)
roles.manage              Editar la matriz de permisos de roles
audit.view                Ver el registro de auditoría
```

### Roles (`roles`, todos `is_system = true`)

`MASTER_GLOBAL` (Master global), `ADMIN` (Administrador), `OPERADOR` (Operador), `REUNIONES` (Reuniones), `LECTURA` (Lectura).

### Permisos por rol actuales

- **MASTER_GLOBAL**: todos.
- **ADMIN**: todos menos `roles.manage`.
- **OPERADOR**: dashboard.view, visualization.view, people.view/create/edit/deactivate, associations.view/create/edit/manage_members, meetings.view/create/edit/change_status/manage_invitations/attendance_manual, forms.view/create/edit/publish/review_duplicates.
- **REUNIONES**: dashboard.view, meetings.view, meetings.change_status, meetings.manage_invitations, meetings.attendance_manual.
- **LECTURA**: dashboard.view, visualization.view, people.view, associations.view, meetings.view, forms.view.

Nota: el seed **sincroniza `role_permissions` por completo** (agrega y quita para que coincida con el catálogo) y **nunca borra filas de `permissions`**.

### Tipos de organización (`organization_types`: key, name, level)

`poder` Poder 0 · `ministerio` Ministerio 1 · `ente_autarquico` Ente autárquico 1 · `ente_publico_no_estatal` Ente público no estatal 1 · `dependencia` Dependencia 2 · `jubilados_pensionados` Jubilados y pensionados 0.
(Los organismos concretos NO se siembran: los carga un administrador. **No cargues nombres de organismos reales en el seed.**)

Nota sobre el esquema: el organigrama real puede tener más de dos niveles (ministerio → secretaría → subsecretaría → dirección → repartición). Proponé si conviene agregar tipos intermedios (`secretaria`, `subsecretaria`, `direccion_general`, `direccion`, `reparticion`) con sus `level`, sin romper los existentes.

### Tipos de asociación (`association_types`: key, name)

`delegados_personal` Delegados del personal · `delegados_congresales` Delegados congresales · `consejo_directivo` Consejo Directivo · `comision` Comisión · `agrupacion` Agrupación · `grupo_trabajo` Grupo de trabajo.

### Configuración por defecto (`app_settings`, solo si la clave no existe)

`sutecba_tz` = "America/Argentina/Buenos_Aires" · `checkin_rate_limit_per_ip_per_10min` = 30 · `login_rate_limit_per_account_per_10min` = 5 · `qr_rotation_seconds` = 45 · `invitation_response_editable_until_meeting_start` = true.

## G. Formato de la respuesta

1. Lista de cualquier **contradicción o duda** que aún tengas (preguntame antes de asumir).
2. Un bloque de código por archivo, con su nombre arriba: `0012_…sql` … `0019_…sql` y `seed_0001.sql`. Cada uno con su verificación y su down.
3. **Lista final de catálogo nuevo** en formato `{ key, description }` (permisos), roles/módulos y la matriz `rol → permisos` completa actualizada, para pegar en `catalog.ts`.
4. **Pruebas de aislamiento para la capa servidor** (enumeradas, en prosa), separadas de las pruebas SQL.
5. Resumen de **decisiones y supuestos**.

Si la respuesta es muy larga, entregala en partes numeradas (por ejemplo `0012–0014`, luego `0015–0017`, luego `0018–0019 + seed + listas`) y esperá mi "seguí" entre partes.
