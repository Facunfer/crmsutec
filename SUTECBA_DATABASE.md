# Base de datos — CRM SUTECBA

> Etapa 2. Complementa `SUTECBA_ARCHITECTURE.md` (decisiones D1-D16). Este documento describe el esquema real, tal como quedó aplicado por las migraciones en `db/migrations/`.

## 1. Cómo se ejecuta hoy (desarrollo local)

No hay Postgres ni Docker instalados en la máquina de desarrollo. Por decisión del usuario, la base local corre con **PGlite** (`@electric-sql/pglite`), Postgres compilado a WASM embebido en el propio proceso de Node — sin instalar nada a nivel sistema. El mismo SQL corre después contra un Postgres real sin cambios de esquema (ver D2 en `SUTECBA_ARCHITECTURE.md`).

```bash
npm install
npm run migrate      # aplica db/migrations/*.sql contra .data/pglite-local
npm run seed         # roles, permisos, configuración por defecto (sin personas de ejemplo)
npm run create-admin -- --email=vos@sutecba.org.ar --name="Tu Nombre"
npm test             # tests de integración contra .data/pglite-test-<uuid> (SUTECBA_ENV=test)
npm run typecheck
```

Para apuntar a un Postgres real (staging/producción, o un local que el usuario instale después), alcanza con definir `SUTECBA_DATABASE_URL` en `.env`; el código de acceso a datos (`lib/db/client.ts`) no cambia.

> **Importante**: nunca correr `npm run migrate`/`npm run seed`/un script suelto contra `.data/pglite-local` mientras `npm run dev` está corriendo. PGlite es un motor embebido por proceso: dos instancias abiertas contra el mismo directorio no se sincronizan entre sí (mismo problema de fondo que el addendum de la Etapa 3 en `SUTECBA_ARCHITECTURE.md`, pero esta vez entre dos procesos de Node en vez de entre capas de Next). Pasó de verdad probando la Etapa 4: se corrió `npm run seed` con el dev server abierto y el server siguió sin ver el permiso nuevo hasta reiniciarlo. Regla: **parar el dev server antes de correr cualquier script de base, siempre.**
>
> **Más importante todavía**: parar el dev server casi siempre significa matarlo de forma abrupta (`Stop-Process -Force`/`kill -9`), porque en la práctica no hay una señal de cierre prolijo disponible para pararlo de otra forma. Eso puede **corromper** `.data/pglite-local` de verdad — pasó en la Etapa 5, el archivo quedó irrecuperable (`RuntimeError: Aborted()` del runtime WASM de PGlite al reabrirlo). Por diseño, `.data/pglite-local` es descartable: si esto pasa, se recrea en un minuto y no se pierde nada versionado ni ningún test (cada test usa su propio directorio en `.data/pglite-test-<uuid>`, nunca este).
>
> ```bash
> rm -rf .data/pglite-local
> npm run migrate
> npm run seed
> npm run create-admin -- --email=... --name="..."
> ```

> **Concurrencia real dentro de un mismo proceso (Etapa 7)**: `kysely-pglite` comparte una única sesión de PGlite entre todas las "conexiones" que entrega Kysely, así que dos `db.transaction().execute()` en vuelo al mismo tiempo (por ejemplo, dos check-ins casi simultáneos) podían intercalar su `BEGIN`/`COMMIT` y corromper el estado de transacción del otro. `lib/db/client.ts` serializa las transacciones con un mutex propio cuando el backend es PGlite (no hace falta ni se aplica contra Postgres real vía `pg.Pool`, donde cada conexión ya es independiente). Detalle completo, con el error real reproducido, en el addendum de la Etapa 7 de `SUTECBA_ARCHITECTURE.md` (sección D2).

## 2. Guardas del runner (`lib/db/guards.ts`, `scripts/migrate.ts`, `scripts/seed.ts`)

Se ejecutan siempre, antes de tocar cualquier tabla:

1. **Destino bloqueado** (`assertNotBlockedTarget`): si la URL de conexión o el directorio de PGlite contiene `dxoarslfifotigcgokmf` o `aysbehxlrgtacjdwmhsp` (proyectos de otro cliente), aborta antes de conectar.
2. **Huella de otro sistema** (`assertNoForeignFootprint`): si la base tiene tablas `personas`, `usuarios`, `sesiones`, `interacciones_personas`, `usuarios_asignaciones`, o cualquiera con prefijo `wa_`/`formulario_`/`email_`, aborta.
3. **Identidad del sistema** (`assertOrBootstrapSystemIdentity`): en una base vacía crea `sutecba_meta` (`system='sutecba-crm'`); en una base con tablas pero sin esa marca, aborta.
4. **Confirmación en producción** (`assertProductionConfirmed`): con `SUTECBA_ENV=production` exige el flag `--yes`.
5. **Migraciones destructivas** (`assertNoDestructiveWithoutFlag`): cualquier `DROP`, `TRUNCATE` o cambio de tipo de columna requiere `--allow-destructive` explícito.

Las tres primeras guardas más el mecanismo de append-only de `audit_logs` y el índice único parcial de `people.dni` están cubiertos por `tests/integration/schema-guarantees.test.ts` (corre contra una base de test descartable, nunca contra la de desarrollo).

## 3. Tablas

### Autenticación y RBAC (`0001_auth_and_rbac.sql`)

| Tabla | Notas |
|---|---|
| `roles` | Catálogo (`MASTER_GLOBAL`, `ADMIN`, `OPERADOR`, `REUNIONES`, `LECTURA`). `is_system=true` por defecto. |
| `permissions` | Catálogo de permisos granulares (`people.export`, `meetings.attendance_manual`, etc.), fuente de verdad en `lib/permissions/catalog.ts`, sincronizado por `scripts/seed.ts`. |
| `role_permissions` | N:M, `on delete cascade` (es configuración, no trazabilidad). |
| `users` | `permissions_version` (D4): se incrementa al cambiar rol/estado/contraseña, invalida sesiones viejas sin esperar el TTL. `status` activo/inactivo, nunca se borra (R8). Email único por `lower(email)`. |
| `sessions` | `token_hash` (nunca el token en claro), `permissions_version_snapshot` comparado contra `users.permissions_version` en cada request, `expires_at`, `revoked_at`. |
| `login_attempts` | Base del rate limit combinado cuenta+IP (D4/D13), en tabla y no en memoria de proceso. |

**FKs hacia `users`: siempre `on delete restrict`** (R8) — nunca se borra un usuario, así que en la práctica nunca se dispara, pero la regla queda explícita en el esquema, no solo en el código de aplicación.

### Organismos (`0002_organizations.sql`)

`organization_types` (nivel: Ministerio, Ente autárquico, Poder, Legislatura, Dependencia, etc.) + `organizations` (autorreferencial vía `parent_id`). Modela que SUTECBA representa a los tres poderes, entes autárquicos, la Legislatura, entes no estatales y jubilados/pensionados — no solo "Ministerio → Dependencia" (D8).

### Personas (`0003_people.sql`)

- `people`: núcleo (nombre, apellido, DNI, email, teléfono, organismo) + `custom_fields jsonb` (GIN) para lo no estructural + `person_field_definitions` para las definiciones (modelo híbrido, D6).
- **DNI**: `dni text` con índice único parcial `where dni is not null and status <> 'merged'` — permite reingresar el mismo DNI solo después de que la fila anterior fue fusionada. Para cambiar esta política (por ejemplo, aceptar DNI duplicado con otro criterio) se reemplaza este índice por migración, documentando el motivo acá.
- **Edad** (D7): `birth_date` calculado en consulta, o `declared_age` + `declared_age_at` si solo se conoce una edad declarada en un momento dado. Nunca un número de edad guardado sin fecha de referencia.
- **Promoción de un campo personalizado a columna real**: (1) migración que agrega la columna, (2) `update people set columna_nueva = custom_fields->>'clave'`, (3) desactivar (`active=false`) la definición en `person_field_definitions` sin borrarla (conserva el histórico de qué significaba esa clave).
- **Búsqueda por nombre/apellido sin acentos — resuelto en la Etapa 4, parcialmente**: PGlite sí trae `pg_trgm`/`unaccent` como módulos "contrib" importables (`@electric-sql/pglite/contrib/{pg_trgm,unaccent}`), pasados como `extensions` al crear la instancia (`lib/db/client.ts`) y habilitados con `CREATE EXTENSION` (migración `0009_search_extensions.sql`). Lo que **no** funcionó fue indexar una expresión que envuelve `unaccent()` en una función propia `IMMUTABLE`: PGlite tira `function unaccent(text) does not exist` al crear el índice, aunque la función figura en `pg_proc` — parece un bug/límite de su motor con la resolución de funciones de extensión dentro de otra función SQL. Se abandonó el índice de expresión (no hay `0010`) y la búsqueda de personas usa `ILIKE` simple (sensible a acentos) hasta que esto se resuelva o se migre a un Postgres real, donde el mismo SQL debería funcionar sin este problema — no reintentar sin primero probarlo contra Postgres de verdad.

### Asociaciones (`0004_associations.sql`)

`association_types` (catálogo configurable: delegados, comisiones, agrupaciones, etc. — sección 4 del prompt) + `associations` + `association_managers` (responsables, usuario o persona) + `people_associations` (N:M con historial: único índice parcial por `(person_id, association_id) where status='active'`, permite ver altas/bajas pasadas sin perder el registro — R8).

### Reuniones (`0005_meetings.sql`, ampliada en `0011_meeting_invitations_withdraw.sql` — Etapa 6)

- `meetings`: estado (`draft/scheduled/in_progress/finished/cancelled/overdue_unclosed`), configuración de QR (`qr_mode`, `qr_secret_version`, tolerancias de check-in) ya prevista desde el modelo de datos aunque la lógica se implemente en la Etapa 7. `overdue_unclosed` **nunca se escribe**: se calcula al leer (`lib/meetings/state-machine.ts#isOverdueUnclosed`) para una reunión `scheduled`/`in_progress` cuya `ends_at` ya pasó — así se cumple "no se finaliza sola" sin necesitar un job.
- `meeting_invitation_batches`: guarda los criterios de audiencia usados (JSON), para poder explicar después "por qué esta persona fue invitada".
- `meeting_invitations`: **dos dimensiones** (D9) — `response_status` (pending/confirmed/declined) y `attendance_status` (unknown/attended/absent). `token_hash` único, nunca el token en claro (D10). `unique (meeting_id, person_id)`: re-invitar es idempotente. `withdrawn_at`/`withdrawn_by` (Etapa 6): "quitar invitado" nunca borra la fila (R8) — la marca, y si se vuelve a invitar a la misma persona más tarde, se revive la misma fila con un token nuevo en vez de violar el UNIQUE.
- `meeting_attendance`: `unique (meeting_id, person_id)` evita duplicados de check-in a nivel base, no solo en código; `method` distingue token/DNI/email/teléfono/manual.
- `public_link_attempts` (`0010_public_link_attempts.sql`): rate limit genérico por `scope` (`invitation_view`, `invitation_respond`, y desde la Etapa 7 también `checkin_qr`, `checkin_identify`, `checkin_confirm`, `invitation_checkin`) + identificador + IP, en tabla y no en memoria (D4/D13), reutilizado por `lib/security/public-rate-limit.ts`.

### Formularios (`0006_forms.sql`)

`forms` (estado, slug único, política de identificación/actualización) + `form_versions` (snapshot inmutable del esquema en cada publicación, para no reinterpretar respuestas viejas) + `form_fields` (edición pre-publicación, con `person_field_mapping` compartido con el registro de campos de Personas) + `form_actions` (acciones post-envío, hoy solo `add_to_association`) + `form_submissions` (`raw_payload` inmutable + `idempotency_key` único) + `person_duplicate_candidates` (bandeja de casos ambiguos, nunca fusión automática).

### Notificaciones y auditoría (`0007_notifications_and_audit.sql`)

- `notification_outbox`: único canal implementado en el MVP es `manual_link` (D14); el resto (`email`, `whatsapp`, `sms`) son valores válidos para cuando se conecte un proveedor real, sin tocar esta tabla.
- `audit_logs`: **append-only forzado por trigger**, no solo por convención — cualquier `UPDATE`/`DELETE` directo levanta una excepción de Postgres (`sutecba_audit_logs_no_mutation`), verificado en `tests/integration/schema-guarantees.test.ts`.

### Configuración (`0008_settings.sql`)

`app_settings` (clave/valor jsonb). Sembrado con valores por defecto (zona horaria, umbrales de rate limit, rotación de QR) sin sobreescribir si ya existen.

### Bootstrap (creadas por el runner, no por un archivo de migración numerado)

- `sutecba_migrations`: registro de qué migraciones se aplicaron.
- `sutecba_meta`: marca de identidad del sistema (fila única, `system='sutecba-crm'`).

## 4. Reglas de borrado

Ninguna tabla de trazabilidad tiene `on delete cascade`/`set null` hacia `people`, `users`, `meetings`, `associations` o `forms` — todas usan `restrict` (R8). Las bajas son lógicas: `people.status`, `associations.status`, `users.status`, `people_associations.status`, más los campos `removed_at`/`removed_by` donde aplica. `role_permissions` es la única relación con `cascade`, porque son datos de configuración (qué permisos tiene un rol), no historial de una entidad de negocio.

## 5. Pendiente explícito de esta etapa

- No hay una instancia de Postgres real probada todavía (solo PGlite local) — la rama `SUTECBA_DATABASE_URL` de `lib/db/client.ts` está escrita pero sin ejercitar.
- `unaccent`/`pg_trgm` para búsqueda: extensiones habilitadas, pero el índice de expresión con `unaccent` no funciona en PGlite (ver sección 3, Personas) — búsqueda hoy es `ILIKE` sensible a acentos. Reintentar el índice cuando haya un Postgres real.
- El detalle de campos "previstos a futuro" en `people` (domicilio, barrio, situación laboral, número de afiliado, etc. — sección 7.2 del prompt) queda modelado vía `custom_fields`/`person_field_definitions` hasta que se decida cuáles son núcleo.
- Afiliación sindical y cualquier campo que la revele: cuando se cargue, debe pasar por `person_field_definitions.sensitive=true` y el permiso `people.view_sensitive` — no hay todavía UI para cargarlo (Etapa 4/9), y la recomendación de validación legal queda para `docs/datos-personales.md` (Etapa 19).
