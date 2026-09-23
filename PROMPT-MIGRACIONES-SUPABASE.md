# PROMPT PARA CHATGPT — Migraciones de SUTECBA para Supabase

> Instrucciones de uso: abrí un chat nuevo, adjuntá el archivo `MIGRACIONES-ACTUALES-0001-0011.sql` (las 11 migraciones que ya existen concatenadas) y pegá todo lo que está debajo de la línea.

---

Actuá como arquitecto de bases de datos PostgreSQL senior, con experiencia en Supabase y en sistemas con datos personales sensibles. Necesito que me generes **migraciones SQL incrementales** para una base PostgreSQL alojada en **Supabase (proyecto nuevo, propio, vacío)**.

## 1. Contexto

SUTECBA es un sindicato del sector público de la Ciudad de Buenos Aires. Ya existe un CRM propio (Next.js + TypeScript + Kysely) con **11 migraciones ya escritas** que te adjunto en `MIGRACIONES-ACTUALES-0001-0011.sql`. Hoy corre sobre PGlite (Postgres embebido) y ahora se migra a **Supabase real**. La base de Supabase está vacía: no hay datos que migrar, solo esquema.

Módulos existentes: usuarios/roles/permisos, organizaciones (jerárquicas), personas, asociaciones, reuniones con QR de asistencia, formularios públicos con deduplicación, auditoría, notificaciones.

**Lo que tenés que hacer**: (A) dejar las 11 migraciones existentes aplicables en Supabase (revisar compatibilidad, sin reescribirlas salvo lo indispensable), y (B) escribir las migraciones nuevas `0012`, `0013`, `0014`… descritas abajo. **No reconstruyas lo que ya existe; ampliá.**

## 2. Reglas duras (no negociables)

- **R1** Nada compartido con otros sistemas. Base y credenciales propias.
- **R5** Los permisos se validan en el servidor; ocultar un botón no es un permiso.
- **R7** Datos sensibles (la afiliación sindical es dato sensible, Ley 25.326 de Argentina). DNI, email y teléfono se enmascaran salvo permiso `people.view_sensitive`.
- **R8** Conservadores con la trazabilidad: **prohibido `ON DELETE CASCADE` y `SET NULL`** hacia entidades con historial; usar `ON DELETE RESTRICT`. Nada de borrados físicos de datos con historial: usar estados/vigencias (`active`, `valid_to`, `revoked_at`).
- Autenticación **propia** del CRM (tabla `users` + bcrypt + tabla `sessions`). **No se usa Supabase Auth** ni `auth.uid()`. El CRM accede con conexión Postgres directa desde su servidor, **nunca desde el navegador**.
- Identificadores existentes: `uuid` con `gen_random_uuid()`. Mantener ese tipo y los nombres existentes. No cambiar los IDs existentes.
- Fechas de eventos: `timestamptz`. Nacimientos y vigencias: `date`. DNI, CUIL y teléfonos: `text`, nunca numéricos.
- `JSONB` solo para datos originales, campos personalizados y metadatos; nunca para reemplazar relaciones.
- Todo cambio va en migraciones versionadas e idempotentes cuando sea razonable. Comentá el *por qué* de las decisiones no obvias, en español.

## 3. Decisiones de negocio YA TOMADAS

1. **Jerarquía**: un usuario asignado a un **área** accede a las reparticiones dependientes (descendientes). Un usuario asignado a una **repartición** accede únicamente a esa. Un usuario puede tener **varios alcances**.
2. **Roles = acciones permitidas; alcances = registros accesibles.** Regla de acceso: *usuario activo + permiso para la acción + alcance sobre la unidad del registro*.
3. **Una persona tiene UNA sola repartición** (la actual, `people.organization_id`). No hay múltiples vínculos laborales simultáneos ni "fichas compartidas" entre reparticiones. **No crear `person_record_scopes`.**
4. **Traspaso de repartición**: si una persona cambia de repartición, el **usuario master de la repartición de origen** (permiso `people.transfer` + alcance sobre la repartición actual de la persona) puede trasladarla a otra. Al hacerlo:
   - Se actualiza `people.organization_id` a la nueva repartición.
   - Se registra un evento en una tabla histórica nueva `person_organization_transfers` (persona, repartición origen, repartición destino, fecha, usuario que lo hizo, motivo obligatorio). **Nunca se borra ni edita.**
   - A la repartición destino la persona **le aparece** (pasa a estar en su alcance).
   - A la repartición de origen **le queda constancia**: puede ver, en un listado de traslados, nombre, fecha y repartición destino, pero **pierde acceso a la ficha completa** y a la ficha de la persona.
   - Las **interacciones ya registradas conservan su `owner_organization_id` original**: la repartición nueva NO ve el detalle de las interacciones de la anterior, y la anterior sigue viendo las suyas. Acceder a una persona no habilita automáticamente todas sus interacciones.
   - El destino puede ser cualquier repartición activa (no hace falta tener alcance sobre ella).
5. **Interacciones separadas**: tablas `person_interactions` y `association_interactions` (historiales distintos), cada una con su propio alcance organizativo (`owner_organization_id`).
6. **Importaciones**: los archivos importados conservan procedencia por fila y permiten revisar duplicados; la importación debe ser **repetible sin duplicar** y **nunca fusiona automáticamente** coincidencias ambiguas.
7. **Alcances jerárquicos calculados al vuelo** con CTE recursiva sobre `organizations.parent_id` (sin tabla de cierre). Proveé una función SQL `organization_descendants(uuid)` (o vista) para reutilizar.
8. **Las tablas del CRM NO deben quedar expuestas por la API pública de Supabase** (PostgREST / clave anon).

## 4. Qué ya existe (no recrear; ver el archivo adjunto)

`roles`, `permissions`, `role_permissions`, `users` (con `permissions_version`, `status`), `sessions`, `login_attempts`, `organization_types` (con `level`), `organizations` (con `parent_id`, `type_id`, `active`), `people` (dni/email/phone/organization_id/custom_fields/status active|inactive|merged, `merged_into_id`, índice único parcial de DNI), `person_field_definitions`, `association_types`, `associations`, `association_managers`, `people_associations`, `meetings`, `meeting_associations`, `meeting_invitation_batches`, `meeting_invitations`, `meeting_attendance` (unique meeting_id+person_id, `correction_reason`, `registered_by`), `forms`, `form_versions`, `form_fields`, `form_actions`, `form_submissions`, `person_duplicate_candidates`, `notification_outbox`, `audit_logs` (append-only por trigger), `app_settings`, `public_link_attempts`, extensiones `pg_trgm` y `unaccent`.

## 5. Migraciones nuevas que necesito

### 0012 — Estructura organizativa y alcances
- Ampliar `organizations` con: `official_code text` (único cuando no es nulo), `valid_from date`, `valid_to date`, y control de ciclos en la jerarquía (una unidad no puede ser su propio ancestro; trigger o constraint, justificá cuál).
- `organization_aliases`: nombre alternativo → organización, `normalized_alias`, estado de aprobación (`pending`/`approved`/`rejected`), quién aprobó y cuándo. Único por alias normalizado aprobado.
- `user_scopes`: `user_id`, `organization_id`, `include_descendants boolean`, `granted_by`, `granted_at`, `revoked_at`, `revoked_by`. Una fila revocada no se borra. Único parcial: un mismo (usuario, unidad) no puede tener dos alcances activos.
- Función `organization_descendants(uuid)` y una función/vista `user_accessible_organizations(user_id uuid)` que devuelva el conjunto de organizaciones accesibles (alcances activos + descendientes cuando corresponda).
- Permisos nuevos a insertar en `permissions` (con `key` y descripción, siguiendo el formato existente): `scopes.manage`, `people.transfer`, `interactions.view`, `interactions.create`, `interactions.edit`, `imports.view`, `imports.run`, `imports.review`. Indicá qué roles existentes los reciben en `role_permissions` (roles: MASTER_GLOBAL, ADMIN, OPERADOR, REUNIONES, LECTURA; proponé y justificá; MASTER_GLOBAL = todo).

### 0013 — Traspasos de personas
- `person_organization_transfers` (append-only: bloquear UPDATE y DELETE con trigger, igual que `audit_logs`): `id`, `person_id`, `from_organization_id`, `to_organization_id` (ambos NOT NULL, RESTRICT, y `from <> to`), `reason text not null` (no vacío), `transferred_by`, `transferred_at`.
- Una **función SQL transaccional** `transfer_person(person_id, to_organization_id, reason, actor_user_id)` que: bloquee la fila de la persona, verifique que no esté `merged`, que el destino esté activo, que actor y persona sean consistentes, actualice `organization_id` (incrementando `version`), inserte el evento y devuelva el registro creado. La verificación de permiso/alcance del actor la hace el servidor, pero la función debe **validar también** que el actor tenga un alcance activo sobre la repartición actual de la persona (defensa en profundidad). Justificá.
- Índices para listar traslados por repartición origen y destino.

### 0014 — Interacciones
- Catálogos `interaction_types` y `interaction_channels` (`key`, `name`, `active`, orden), con seed inicial razonable (consulta, llamada, gestión, visita, otro / presencial, teléfono, correo, WhatsApp, formulario, otro).
- `person_interactions` y `association_interactions` con estructura consistente entre ambas: `id`, `person_id` / `association_id` (RESTRICT), `owner_organization_id` (NOT NULL, RESTRICT: unidad responsable y de alcance), `occurred_at timestamptz`, `interaction_type_id`, `channel_id`, `subject`, `description`, `status` (check con valores razonables), `outcome`, `responsible_user_id`, `next_follow_up_at`, `meeting_id` (opcional, RESTRICT), `created_by`, `created_at`, `updated_at`, y `version`. En `association_interactions` agregar `contact_person_id` opcional.
- Tabla `interaction_links` para vincular una interacción de persona con una de asociación (misma gestión) sin contarlas como dos gestiones independientes; sin cascade.
- Índices en persona/asociación + fecha, `owner_organization_id`, `next_follow_up_at`, `responsible_user_id`.
- **Las interacciones no se borran** (usar `status`, por ejemplo `cancelled`/`voided`, con motivo).

### 0015 — Importación
- `import_batches` (responsable, estado, fechas), `import_files` (nombre, **hash de contenido** único por lote, referencia externa al original en Drive, sin guardar el binario), `import_rows` (hoja, número de fila, `raw_data jsonb`, `normalized_data jsonb`, hash de fila, **único (archivo, hoja, número de fila)** y único por hash dentro del lote donde corresponda), `import_issues` (severidad error/warning, código, mensaje, estado de resolución, quién resolvió), `import_entity_links` (fila → entidad creada/vinculada, tipo de entidad y `entity_id`).
- Flujo de estados de fila: `staged → normalized → in_review → approved → applied` (más `rejected`/`skipped`). Reutilizar `person_duplicate_candidates` para coincidencias pendientes; explicá si necesita ampliarse (por ejemplo, un `source` que apunte a `import_rows`) y hacelo sin romper lo existente.
- Reglas: repetir la importación del mismo archivo **no duplica**; coincidencias ambiguas **no se fusionan solas**; `raw_data` contiene DNI/email/teléfono, así que debe quedar señalado como dato sensible en un comentario de tabla.
- **No modeles `person_identifiers` ni `person_contacts` todavía** (se difieren a una fase posterior).

### 0016 — Seguridad en Supabase
- Crear un rol de aplicación **limitado** `sutecba_app` (sin `SUPERUSER`, sin `CREATEDB`/`CREATEROLE`), **distinto** del rol que ejecuta migraciones, con `GRANT` de `SELECT/INSERT/UPDATE/DELETE` solo donde corresponda: **sin `DELETE`** ni `UPDATE` en tablas append-only o de trazabilidad (`audit_logs`, `person_organization_transfers`, `meeting_attendance` si corresponde, etc.) y con `EXECUTE` sobre las funciones necesarias. No pongas una contraseña real en el SQL: usá un placeholder `<<CONTRASEÑA_A_DEFINIR>>`.
- `REVOKE ALL` sobre todas las tablas, secuencias y funciones del esquema `public` para `anon` y `authenticated`, y `ALTER DEFAULT PRIVILEGES` para que las tablas futuras tampoco queden expuestas.
- `ENABLE ROW LEVEL SECURITY` en **todas** las tablas del CRM, sin políticas para `anon`/`authenticated` (default-deny) y una política explícita para `sutecba_app` (`USING (true)`, `WITH CHECK (true)`), dejando claro en un comentario que **el filtrado por alcance lo hace el servidor** y que RLS acá es una barrera contra exposición accidental de la API pública, **no** el mecanismo de autorización. Discutí brevemente si conviene además establecer `set_config('app.current_user_id', …, true)` por transacción para una segunda capa futura, pero **no lo implementes ahora**.
- Explicá qué cadena de conexión usar (pooler en modo transacción vs. conexión directa, y por qué importa para las transacciones y los `set_config`).

## 6. Puntos técnicos a resolver explícitamente

1. **Compatibilidad Supabase de las 11 migraciones existentes**: `gen_random_uuid()`, triggers de solo-anexado, `inet`, índices con `unaccent`/`pg_trgm` (en Supabase las extensiones suelen instalarse en el esquema `extensions`; una función `unaccent` en un índice de expresión requiere que sea inmutable o un *wrapper* inmutable — indicá cómo resolverlo sin romper el código que ya usa esos índices).
2. Orden de aplicación y cómo **verificar** cada migración (consultas de comprobación posteriores a cada una).
3. **Rollback**: para cada migración nueva, un script `down` documentado (aunque sea conservador: sin borrar datos históricos).
4. Cada migración debe poder correr dentro de una transacción; si alguna instrucción no puede (por ejemplo, `CREATE INDEX CONCURRENTLY`), indicalo.
5. Lista de **tests de aislamiento en SQL** que debería correr después (usuario A no ve registros de la repartición B; un traspaso no expone interacciones antiguas; el rol `sutecba_app` no puede borrar `audit_logs`; `anon` no puede leer nada).

## 7. Formato de tu respuesta

1. **Resumen de incompatibilidades o errores** que veas en las 11 migraciones existentes al pasarlas a Supabase (con el arreglo mínimo propuesto).
2. Un archivo SQL por migración (`0012_…sql` a `0016_…sql`), cada uno en su bloque de código y con el nombre de archivo arriba, ordenados para aplicar tal cual.
3. Cada migración seguida de su bloque de **verificación** y de su **down**.
4. Un apartado final de **decisiones y supuestos** donde marques cualquier cosa que hayas asumido y que yo deba confirmar, y toda **contradicción** entre esta consigna y el esquema existente.
5. No inventes tablas, columnas ni permisos que contradigan el esquema adjunto: si dudás de un nombre, mirá el archivo y, si sigue sin quedar claro, preguntame **antes** de asumir.
6. Todo en **español rioplatense**, comentarios SQL incluidos.

**No ejecutes ni supongas acceso a mi base.** Solo generás los archivos SQL y las verificaciones.
