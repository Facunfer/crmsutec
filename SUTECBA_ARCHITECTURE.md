# Arquitectura — CRM SUTECBA

> Etapa 1 del plan de construcción. Este documento se escribe **antes** de implementar y se actualiza al cierre de cada etapa. No contiene datos reales del sindicato ni del CRM de referencia — solo decisiones de diseño.

## 0. Estado de las variables de sesión

| Dato | Valor resuelto |
|---|---|
| CRM de referencia | `C:\Users\usuario\Downloads\portal-crm` (solo lectura, ver Etapa 0) |
| Proyecto nuevo | `C:\Users\usuario\Downloads\sutecba` (este repo) |
| Base de datos | **Local** (PostgreSQL). No se creó ningún proyecto cloud. Pendiente: si el usuario provee una instancia definitiva (Supabase u otro Postgres administrado), solo cambia `SUTECBA_DATABASE_URL` — ver decisión D2. |
| Dominio / despliegue | Sin definir. No se toca VPS, nginx ni PM2 en esta etapa ni en las siguientes salvo pedido explícito (regla R2 y sección 16 del prompt). |

## 1. Visión general

CRM independiente para SUTECBA (sindicato de trabajadores del GCBA). Gestiona personas (afiliados y no afiliados), la estructura interna del sindicato (delegados, comisiones, agrupaciones) como "asociaciones", reuniones con invitación/QR/asistencia, y formularios públicos que alimentan la base de personas. Mismo *approach* arquitectónico que el CRM de referencia (Next.js full-stack, seguridad 100% server-side, sin exponer credenciales al navegador) pero con:

- Base de datos, esquema, autenticación, permisos y despliegue **completamente propios** (R1/R2).
- Acceso a datos por conexión directa a PostgreSQL (no PostgREST/Supabase-JS) — ver D2.
- Cero contenido, nombres, roles o dominios del cliente anterior (R3) — verificado por test centinela (§8.4).
- Modelo de dominio propio: organismos jerárquicos en vez de "comuna", asociaciones sindicales en vez de asociaciones civiles, sin datos de salud/ObSBA (R7).

## 2. Diagrama de módulos

```
                    ┌─────────────────────────┐
                    │        Navegador          │
                    │ (Server Components/HTML)  │
                    └────────────┬───────────────┘
                                 │ solo HTML/RSC, sin credenciales
        ┌────────────────────────┼────────────────────────┐
        │                        │                          │
┌───────▼───────┐      ┌─────────▼─────────┐      ┌─────────▼─────────┐
│  Rutas públicas │      │  Rutas protegidas   │      │  Route Handlers    │
│  /login          │      │  /(protegido)/*     │      │  /api/checkin       │
│  /reunion/...     │      │  requireModulo()     │      │  /api/qr/live        │
│  /f/[slug]        │      │  en layout+página     │      │  (SSE/polling)        │
└───────┬───────┘      └─────────┬─────────┘      └─────────┬─────────┘
        │                        │                          │
        └────────────┬────────────┴─────────────┬────────────┘
                     │                          │
             ┌───────▼───────┐          ┌────────▼────────┐
             │  Server Actions │          │  lib/* (dominio)  │
             │  (mutaciones)    │◄────────►│  people, meetings,│
             └───────┬───────┘          │  associations, forms,│
                     │                  │  audit, permissions   │
                     │                  └────────┬────────┘
                     │                          │
             ┌───────▼──────────────────────────▼───────┐
             │        lib/db (único cliente, server-only)  │
             │        Kysely + pg, pool de conexión          │
             └───────────────────┬───────────────────────┘
                                 │
                       ┌──────────▼──────────┐
                       │  PostgreSQL SUTECBA    │
                       │  (local en desarrollo)  │
                       └────────────────────────┘
```

Todo lo que muta datos pasa por `lib/*` (una función = una responsabilidad = una ruta de escritura), nunca se arma SQL en la página ni en el componente.

## 3. Estructura de carpetas (objetivo; se crea de forma incremental por etapa)

```
sutecba/
├─ app/
│  ├─ login/
│  ├─ (protegido)/
│  │  ├─ layout.tsx            # revalida sesión + permisos en cada request
│  │  ├─ dashboard/
│  │  ├─ personas/
│  │  ├─ asociaciones/
│  │  ├─ reuniones/
│  │  ├─ formularios/
│  │  ├─ visualizacion/
│  │  └─ administracion/
│  │     ├─ usuarios/
│  │     ├─ roles/
│  │     ├─ auditoria/
│  │     └─ configuracion/
│  ├─ f/[slug]/                 # formulario público
│  ├─ reunion/
│  │  ├─ invitacion/[token]/    # respuesta pública a invitación
│  │  └─ checkin/[qrToken]/     # check-in público por QR
│  └─ api/
│     ├─ checkin/
│     └─ reuniones/[id]/live/   # polling/SSE del panel en vivo
├─ lib/
│  ├─ db/                       # cliente Kysely+pg, único, server-only
│  ├─ auth/                     # sesiones, cookies, passwords, rate-limit
│  ├─ permissions/               # catálogo de permisos, can(), RBAC
│  ├─ scope/                     # resolvedor de alcance (extensible a futuro)
│  ├─ people/                    # CRUD, normalización, duplicados, export
│  ├─ organizations/              # catálogo jerárquico de organismos
│  ├─ associations/
│  ├─ meetings/                   # máquina de estados, invitaciones
│  ├─ attendance/                  # check-in, QR, panel en vivo
│  ├─ forms/                        # constructor, matching, submissions
│  ├─ audit/                         # única ruta de escritura de auditoría
│  ├─ notifications/                  # interfaz de proveedor + outbox
│  └─ settings/
├─ components/
│  ├─ grid/                     # wrapper AG Grid (AllCommunityModule)
│  ├─ sidebar/
│  ├─ charts/                   # wrappers Recharts
│  ├─ forms/                    # inputs, validación compartida
│  └─ ui/                       # botones, modales, toasts, panel
├─ db/
│  ├─ migrations/                # 0001_xxx.sql, 0002_xxx.sql, ...
│  └─ seeds/
├─ scripts/
│  ├─ migrate.ts                 # runner con guardas (§7.1 del prompt)
│  ├─ seed.ts
│  └─ create-admin.ts
├─ tests/
│  ├─ unit/
│  ├─ integration/
│  ├─ centinela/                 # tests que fallan el build
│  └─ e2e/
├─ docs/
└─ deploy/                        # documentación de despliegue, nada ejecutado
```

## 4. Flujo de datos

1. La UI (Server Component) llama a una función de `lib/<dominio>/queries.ts` que ya aplica el alcance del usuario.
2. Las mutaciones pasan por Server Actions en `app/(protegido)/<módulo>/acciones.ts`, que llaman `assertPermiso(...)` antes de tocar `lib/<dominio>/comandos.ts`.
3. `lib/<dominio>/comandos.ts` abre una transacción Kysely cuando la operación toca más de una tabla (invitaciones masivas, submission→persona→asociación, check-in) y escribe auditoría en la misma transacción.
4. Ningún módulo de dominio importa `pg`/Kysely directo salvo a través de `lib/db`.
5. Las páginas públicas (`/f/[slug]`, `/reunion/invitacion/[token]`, `/reunion/checkin/[qrToken]`) no comparten layout con `(protegido)` y no tienen acceso a sesión de usuario interno.

## 5. Modelo de datos (resumen — detalle completo en `SUTECBA_DATABASE.md`, Etapa 2)

Entidades principales: `users`, `roles`, `permissions`, `role_permissions`, `sessions`, `people`, `person_field_definitions`, `organization_types`, `organizations`, `association_types`, `associations`, `people_associations`, `meetings`, `meeting_invitation_batches`, `meeting_invitations`, `meeting_attendance`, `forms`, `form_fields`, `form_submissions`, `person_duplicate_candidates`, `notification_outbox`, `audit_logs`, `app_settings`, `sutecba_meta`.

## 6. Seguridad (resumen — checklist completo en Etapa 10)

- Ninguna variable con `NEXT_PUBLIC_` para datos de base o secretos.
- Único módulo `lib/db/client.ts` con `assertServerOnly()`.
- Tres capas de permisos: menú, página/layout, acción.
- RLS habilitado igual como defensa en profundidad aunque el acceso normal sea por conexión directa server-only con credencial propia (ver D2 y D5) — evita que una fuga de credencial de solo-lectura exponga todo.
- Tokens públicos: hash en base, nunca el valor en claro (ver D10).
- Zona horaria única (`SUTECBA_TZ`), ver D15.

## 7. Componentes reutilizados / adaptados / descartados

Ver el reporte completo de la Etapa 0 (sección de chat, no repetido acá para no duplicar). Resumen de lo que se copia al repo nuevo, ya desacoplado (sin imports hacia `portal-crm`):

- **Tal cual (patrón)**: `assertServerOnly`, paginador/anti-N+1, esqueleto de auth (usuarios+bcrypt+sesiones+cookie), middleware Edge liviano, mecanismo de tests centinela, configuración de PM2/Next para VPS chico.
- **Adaptado**: permisos y resolvedor de alcance (estructura sí, contenido de dominio no), única ruta de escritura para trazabilidad, wrapper de AG Grid, sidebar responsive, wrappers de Recharts.
- **Descartado**: todo el contenido territorial (comunas, verticales, tags PROF/NAC), geocodificación USIG, mapa de relacionamiento, consultas predefinidas, scripts de paridad, SSO con Reclamos CABA, adaptación PWA/móvil completa (se evalúa aparte si SUTECBA la necesita).

## 8. Decisiones (D1–D16, sección 6.1 del prompt)

Formato: contexto → opciones → elección → motivo → cómo revertir.

### D1 — Ubicación del proyecto
- **Contexto**: dónde vive el código nuevo respecto del CRM de referencia.
- **Opciones**: (a) repo hermano nuevo; (b) rama de `portal-crm`; (c) subcarpeta de `portal-crm`.
- **Elección**: (a). Repo propio en `C:\Users\usuario\Downloads\sutecba`, git inicializado en esta etapa, sin remoto, commits locales por etapa.
- **Motivo**: R2 exige que `portal-crm` sea solo lectura y que no haya import relativo, symlink ni workspace compartido. Un repo separado es la única opción que lo garantiza estructuralmente.
- **Cómo revertir**: no aplica revertir; mover el repo de carpeta no cambia la decisión.

### D2 — Motor y acceso a datos
- **Contexto**: cómo la app habla con Postgres. La referencia usa `supabase-js` server-only sin RLS, con el límite silencioso de 1000 filas de PostgREST y sin transacciones multi-tabla nativas desde el cliente JS.
- **Opciones**: (a) `supabase-js` + funciones SQL (RPC) para lo transaccional; (b) conexión Postgres directa server-only con query builder y transacciones en código.
- **Elección**: (b). **Kysely** (query builder tipado) + **`pg`** (node-postgres) como driver, con pool de conexión en `lib/db/client.ts` (único módulo, `assertServerOnly()`).
- **Motivo**: varios flujos necesitan atomicidad real (invitaciones masivas, submission de formulario → persona → asociación → auditoría, check-in sin duplicados). Con (a) esa atomicidad requeriría escribir una función SQL (RPC) por cada operación transaccional, lo cual termina siendo más código y menos tipado que hacerlo directo en TypeScript con Kysely. Además, evita por completo el techo de 1000 filas de PostgREST sin tener que pensarlo. Postgres sigue siendo Postgres: si más adelante se aloja en Supabase Cloud, solo cambia la cadena de conexión, no el código de acceso a datos.
- **Cómo revertir**: si en el futuro conviene Supabase-JS (por ejemplo para aprovechar Supabase Auth o Realtime), se reemplaza `lib/db/client.ts` y las funciones de `lib/*/queries.ts` sin tocar el modelo de datos ni las Server Actions que las llaman.
- **Addendum de la Etapa 3 (bug real encontrado y corregido)**: Next.js compila el código de servidor en varias "capas" separadas (RSC, SSR, Server Actions, middleware), cada una con su propio grafo de módulos. Un singleton a nivel de módulo (`let kyselyInstance`) **no** es un singleton real ahí: cada capa que importa `lib/db/client.ts` termina abriendo su propia instancia. Con `pg`/Postgres real esto es solo ineficiente (pools de más), pero con **PGlite es un bug de datos real**: dos instancias abiertas contra el mismo directorio no se sincronizan entre sí, así que una escritura hecha desde una Server Action podía quedar invisible para la página que lista esos datos, incluso después de recargar. Se detectó en vivo probando el alta de usuarios (Etapa 3) y se corrigió cacheando la conexión en `globalThis` en vez de en una variable de módulo — `globalThis` sí es compartido entre capas dentro del mismo proceso de Node. Ver `lib/db/client.ts`.
- **Addendum de la Etapa 4 (otro bug real de PGlite, esta vez de conteo)**: `UpdateResult.numUpdatedRows`/`DeleteResult.numDeletedRows` de Kysely **no son confiables con PGlite** (vía `kysely-pglite`): reportan `0n` aunque el `UPDATE`/`DELETE` haya afectado filas de verdad — confirmado a mano ejecutando el mismo `UPDATE` con y sin `RETURNING`. El bloqueo optimista de Personas (`lib/people/commands.ts`) dependía de ese contador y fallaba siempre, aunque el guardado funcionara. Regla desde acá: **cualquier código que necesite saber si un `UPDATE`/`DELETE` afectó filas usa `.returning(...)`  y mira si volvió algo, nunca `numUpdatedRows`/`numDeletedRows`.** Test de regresión que documenta el bug: `tests/integration/pglite-driver-quirks.test.ts`. Volver a probar si alguna vez se actualiza `kysely-pglite`/PGlite.
- **Addendum de la Etapa 5 (corrupción real de PGlite por corte abrupto del proceso)**: matar el proceso de `npm run dev` con `Stop-Process -Force` (o cualquier `kill -9` equivalente) mientras tiene abierta la conexión a `.data/pglite-local` dejó el directorio corrupto — al reabrirlo, PGlite tira un `RuntimeError: Aborted()` de su propio runtime WASM, no un error SQL, y no hay forma de repararlo, solo de recrearlo. Confirmado en esta máquina: `taskkill` sin `/F` respondió explícitamente "este proceso se puede terminar solo de forma forzada", así que un corte limpio no es una opción real en este entorno. Se agregó un manejador de `SIGINT`/`SIGTERM` en `lib/db/client.ts` (`closeDb()` antes de salir) como mejor esfuerzo — ayuda ante un `SIGTERM` normal (systemd/PM2 en un reinicio de verdad), pero no ante un `-Force`/`kill -9`, que ningún proceso de Node puede atrapar. Consecuencia práctica: **`.data/pglite-local` es 100% descartable** — nunca cargar ahí nada que no se pueda recrear en un minuto (`rm -rf .data/pglite-local && npm run migrate && npm run seed && npm run create-admin -- ...`). No afecta a los tests (cada uno usa su propio directorio descartable en `.data/pglite-test-<uuid>`, nunca `pglite-local`) ni a nada versionado.
- **Addendum de la Etapa 6 (dos hallazgos reales, uno de SQL general y uno de permisos)**:
  - `db.where(columna, "in", [])` con un array vacío genera `where columna in ()`, que es un error de sintaxis SQL real (no específico de PGlite: ningún Postgres acepta un `IN` vacío). Rompió la re-generación idempotente de invitaciones (`lib/meetings/invitations.ts`) apenas la tanda no tenía gente nueva ni revivida para buscar nombres. Regla: **antes de un `.where(col, "in", array)`, verificar que `array.length > 0`**, o envolver la consulta en un condicional como se hizo ahí.
  - `setMeetingAssociations` (asociaciones relacionadas de una reunión) solo validaba el permiso `meetings.edit`, sin revisar el estado de la reunión — la UI ocultaba el botón de guardar para una reunión finalizada, pero el comando del servidor lo hubiera aceptado igual si se lo llamaba directo. Es exactamente el caso que R5 pide evitar ("ocultar un botón no es un permiso"): se corrigió agregando la misma validación de estado (`canEditCoreFields`) que ya tenía `updateMeeting`, con test de regresión que llama al comando directamente (no a través de la UI) para probarlo.

### D3 — Migraciones
- **Elección**: archivos SQL versionados en `db/migrations/NNNN_descripcion.sql`, runner propio (`scripts/migrate.ts`) que aplica en orden y registra en `sutecba_migrations`, con las guardas de la sección 7.1 (bloqueo por host, por tablas huella de otros sistemas, exigencia de `sutecba_meta`, confirmación explícita en producción).
- **Motivo**: reproducible desde cero, sin depender de un CLI externo (Supabase CLI) que no hace falta si no estamos en Supabase Cloud.
- **Cómo revertir**: si se adopta Supabase CLI más adelante, los mismos archivos `.sql` son compatibles con su carpeta de migraciones sin reescritura.

### D4 — Autenticación
- **Elección**: mismo patrón de la referencia (`users` + bcrypt + tabla `sessions` + cookie httpOnly/Secure/SameSite), con estas correcciones respecto a los riesgos detectados en la Etapa 0:
  - `users.permissions_version` (entero) incluido en cada fila de `sessions` al crearla; cada request compara contra el valor actual del usuario. Desactivar, cambiar de rol o resetear contraseña incrementa la versión → todas las sesiones anteriores quedan inválidas en el siguiente request, sin esperar el TTL. Corrige el riesgo #1 de la Etapa 0 (snapshot de sesión que no se invalida).
  - Reseteo/cambio de contraseña borra además todas las filas de `sessions` del usuario (doble seguro).
  - Limpieza de sesiones vencidas: oportunista (se borran las vencidas del usuario al leer su sesión) + un `DELETE` programable por cron documentado en `docs/despliegue.md` (no obligatorio para el MVP).
  - Rate limit de login: por cuenta **y** por IP combinadas, con backoff progresivo, guardado en una tabla (`login_attempts`) en vez de memoria de proceso — decisión que se aparta de la referencia a propósito (ver motivo).
  - Cookie propia: `sutecba_session` (no colisiona con `crm_sid` del CRM de referencia si algún día comparten dominio padre).
  - Sin compatibilidad con contraseñas en texto plano: el sistema nuevo no tiene usuarios legados.
  - Supabase Auth: evaluado y descartado; mantener auth propia es consistente con la independencia total de R1 y no ata el proyecto a una cuenta de Supabase Cloud que todavía no existe.
- **Motivo del rate limit en tabla y no en memoria**: la Etapa 0 identificó como riesgo real que el rate limit de la referencia vive en `globalThis` y solo funciona si PM2 corre en `fork`/1 instancia — una futura decisión de infraestructura (escalar a más instancias) rompería la protección sin que nada avise. Para SUTECBA se prefiere pagar el costo mínimo de una consulta a tabla y no heredar esa fragilidad.
- **Cómo revertir**: si el volumen de tráfico de login lo justifica, se puede mover el rate limit a un store en memoria compartido (Redis) sin cambiar la interfaz `lib/auth/rate-limit.ts`.

### D5 — RBAC
- **Elección**: tablas `roles`, `permissions`, `role_permissions`; **rol único por usuario** (`users.role_id`, no tabla `user_roles` N:M) para el MVP. Catálogo de permisos vive en código (`lib/permissions/catalog.ts`) y se sincroniza a la tabla `permissions` con un seed idempotente. Chequeo siempre por permiso (`can(user, "people.export")`), nunca por nombre de rol. Punto de extensión `lib/scope/resolve.ts` preparado (siempre devuelve "alcance total" en el MVP) para un futuro alcance por organismo/dependencia/asociación.
- **Motivo de rol único vs. N:M**: el prompt lo deja opcional ("o rol único si lo justificás"); SUTECBA no tiene, por ahora, un caso de negocio que requiera que una persona tenga dos roles simultáneos, y un rol único simplifica el chequeo de "último MASTER_GLOBAL protegido" (sección 8, requisito de Etapa 3).
- **Cómo revertir**: migrar de `role_id` a una tabla `user_roles` es una migración aditiva (crear tabla, copiar `role_id` como primera fila, no se pierde información).

### D6 — Campos personalizados de Personas
- **Elección**: modelo híbrido — columnas núcleo para los campos siempre presentes + `person_field_definitions` (clave, etiqueta, tipo, opciones, obligatorio, activo, orden, sensible) + columna `custom_fields JSONB` en `people` con índice GIN, validada en el servidor contra las definiciones activas antes de guardar.
- **Alternativa descartada**: EAV puro (tabla `person_field_values` fila por campo). Se descarta porque para consultas de filtro/exportación masiva (que son el caso de uso más frecuente en Personas) EAV requiere pivotear en cada consulta, mientras que JSONB indexado con GIN permite filtrar razonablemente bien con operadores nativos de Postgres (`->>`, `@>`) sin esa complejidad.
- **Procedimiento de "promoción"**: cuando un campo personalizado se vuelve estructural (se usa en la mayoría de los filtros/reportes), se agrega como columna real mediante una migración que la puebla desde `custom_fields->>'clave'` y luego se retira de las definiciones activas (sin borrar el dato histórico del JSONB, por conservadurismo — R8).
- **Registro de tipos compartido**: el mismo catálogo tipo→validación→normalización→render lo usa el constructor de formularios (Etapa 8) para que un campo de formulario pueda mapear a un campo personalizado sin duplicar lógica.
- **Cómo revertir**: no aplica — es aditivo por diseño.

### D7 — Edad
- **Elección**: `people.fecha_nacimiento` (nullable, `date`) y edad **calculada** en consulta (función SQL o expresión `age(fecha_nacimiento)`). Si solo se conoce una edad declarada (no la fecha exacta), se guardan `edad_declarada` (entero) + `fecha_declaracion` (date), y la edad "actual" se estima sumando los años transcurridos desde `fecha_declaracion`. Los filtros de edad siempre operan sobre el valor calculado, nunca sobre un número guardado.
- **Motivo**: exactamente el problema de los semáforos de la referencia (un valor guardado envejece y queda mintiendo); acá se evita de raíz.
- **Cómo revertir**: no aplica.

### D8 — Organismos (Ministerio/Dependencia)
- **Elección**: `organization_types` (nivel: ej. "Ministerio", "Ente autárquico", "Poder", "Dependencia") + `organizations` (autorreferencial: `parent_id`, `type_id`, `nombre`, `activo`), administrable desde Configuración. FK `people.organization_id`. La UI sigue mostrando "Ministerio" y "Dependencia" como etiquetas de los niveles más usados, aunque el modelo real sea un árbol genérico (correcto para los tres poderes, entes autárquicos, Legislatura, entes no estatales y jubilados/pensionados mencionados en la sección 4 del prompt).
- **Motivo**: SUTECBA no tiene una jerarquía uniforme de "Ministerio → Dependencia" (representa also Legislatura, entes autárquicos, jubilados); un árbol genérico administrable lo modela sin forzar casos raros a encajar.
- **Cómo revertir**: si finalmente toda la estructura es de dos niveles fijos, se puede simplificar a dos tablas planas sin perder datos (es una restricción, no una expansión).

### D9 — Invitaciones: estado
- **Elección**: dos columnas independientes en `meeting_invitations`: `response_status` (`pending | confirmed | declined`) y `attendance_status` (`unknown | attended | absent`).
- **Mapeo a los 5 estados pedidos por el usuario** (invited, confirmed, declined, attended, absent): `invited` = fila existe con `response_status=pending`; `confirmed`/`declined` = `response_status` directo; `attended` = `attendance_status=attended` (gana sobre `response_status`); `absent` = reunión finalizada + `attendance_status` sigue en `unknown` o explícitamente `absent`.
- **Motivo**: un estado único no puede representar "confirmó pero no vino" ni "no confirmó pero apareció igual" (caso real esperable en asambleas sindicales).
- **Cómo revertir**: no aplica — es la opción más expresiva, no hay motivo para reducirla.

### D10 — Tokens públicos
- **Elección**: token aleatorio ≥128 bits en base64url generado con `crypto.randomBytes`. En base se guarda **solo el hash SHA-256** del token (columna `token_hash`), nunca el valor en claro. El valor en claro se muestra una única vez al generarlo (para copiar/exportar) y no se puede recuperar después. "Regenerar enlace" genera un nuevo token/hash e invalida el anterior (el hash viejo deja de matchear, el enlace previo devuelve "token inválido").
- **Trade-off documentado**: si en el futuro se agrega envío por email/WhatsApp automático, ese envío debe ocurrir en el mismo momento de la generación (cuando el valor en claro todavía existe en memoria), no leyendo la base después. Esto es intencional: reduce la superficie de qué puede filtrar un token si la base se compromete.
- **Cómo revertir**: si se decide guardar el token en claro (por ejemplo para poder reenviarlo sin regenerarlo), es una migración aditiva (agregar columna `token_plain` nullable), pero baja la seguridad y no se recomienda.

### D11 — QR de asistencia
- Ver detalle completo en la Etapa 7. Elección adelantada: ambos modos (estático con ventana, y rotativo tipo TOTP) soportados con la misma validación HMAC, **rotativo por defecto**. Se documenta acá para que el modelo de datos de `meetings` (Etapa 2) ya contemple la configuración de modo/tolerancia desde el principio.

### D12 — Panel en tiempo real
- **Elección**: *polling* corto (4 segundos) contra un Route Handler protegido (`/api/reuniones/[id]/live`) que reutiliza las mismas funciones de `lib/attendance/queries.ts` que usa la página normal — no hay una fuente de datos paralela para el polling.
- **Motivo**: Supabase Realtime en el navegador exigiría una llave publicable y políticas RLS accesibles desde el cliente, lo cual contradice R4 (ninguna credencial de base llega al navegador) y además ya no aplica porque D2 eligió conexión directa server-only sin exponer ningún endpoint de base al cliente.
- **Cómo revertir**: si el polling genera carga excesiva con reuniones muy concurridas, se reemplaza por Server-Sent Events desde el mismo Route Handler sin cambiar el contrato de datos.

### D13 — Rate limiting y concurrencia de check-in
- **Elección**: límites combinados por `meeting_id` + identificador (DNI/email/teléfono hasheado) + IP, con umbrales altos pensados para cientos de personas detrás de la misma IP (ej. 30 intentos por IP cada 10 minutos, no 5), guardados en tabla (no memoria de proceso) para no heredar el riesgo #3 de la Etapa 0.
- **Motivo**: en una asamblea de 350 personas todas comparten wifi/NAT; un límite estricto por IP bloquearía el ingreso masivo.
- **Cómo revertir**: los umbrales son configuración (`app_settings`), ajustables sin migración.

### D14 — Notificaciones desacopladas
- **Elección**: interfaz `NotificationProvider` (`send(channel, destinatario, payload)`) + tabla `notification_outbox`. En el MVP la única implementación es `manual-link` (no envía nada; solo registra la intención y expone el enlace para copiar/exportar en CSV). Sin conexión a proveedores de email/WhatsApp ni a la infraestructura de envíos existente del usuario (Mautic/enviowpp quedan completamente fuera, por R2).
- **Cómo revertir**: agregar un proveedor real (`email`, `whatsapp`) implica solo escribir una clase que cumpla la interfaz y registrar la fila en `notification_outbox`; no toca el resto del sistema.

### D15 — Zona horaria
- **Elección**: todas las columnas de fecha/hora `timestamptz`. Variable `SUTECBA_TZ=America/Argentina/Buenos_Aires` usada de forma consistente en servidor (cálculos de "últimos 30 días", filtros de fecha) y en la visualización (formateo). Nunca se asume la zona horaria del servidor del SO.
- **Cómo revertir**: no aplica, es la práctica correcta desde el inicio.

### D16 — Grilla
- **Elección**: AG Grid **36.0.2 Community** (misma versión que la referencia, confirmada en Etapa 0), con `AllCommunityModule` registrado a nivel de módulo (no Server-Side Row Model, que es Enterprise). Paginación, orden y filtros resueltos en el servidor (Server Action o Route Handler que devuelve una página), el cliente nunca recibe más filas que las visibles. Test centinela que falla si se recorta el registro de módulos.
- **Cómo revertir**: no aplica sin cambiar de librería de grilla.

## 9. Otras decisiones menores (autonomía, sección 16 del prompt)

- **Framework y versiones**: Next.js 15.5.x + React 19.1.x + TypeScript 5.5.x (mismas versiones probadas en la referencia con este mismo conjunto de librerías — AG Grid 36, Recharts 3 requieren React 19).
- **Validación**: Zod 4.x compartido entre cliente y servidor para los esquemas de Personas, Reuniones y Formularios — mejora deliberada sobre la referencia (Etapa 0 notó que ahí Zod está en dependencias pero casi no se usa; acá sí se adopta como estándar).
- **Test runner**: se reemplaza el harness artesanal de la referencia (`tsx` + funciones `test()` caseras) por **Vitest** — más estándar, mejor soporte de mocks/fixtures para los tests de integración contra la base de test, sin perder el mecanismo de tests centinela (que son simples scripts de escaneo estático, se portan igual con Vitest como runner).
- **Estilos**: Tailwind CSS 3.4.x, sin shadcn/Radix (igual que la referencia: componentes propios simples).
- **Gestor de paquetes**: npm (mismo que la referencia, evita introducir una herramienta nueva sin necesidad).
- **Mapa/Leaflet**: no se instala en el MVP (sin mapa en Asociaciones ni Personas, sección 10). Se agrega solo si aparece un caso de uso real (ej. sedes/delegaciones geolocalizadas).

## 10. Tabla de lecciones trasladadas (sección 6.2 del prompt)

| Lección de la referencia | Aplicación en SUTECBA |
|---|---|
| Indicadores calculados, no guardados | Asistencia, % participación, conteos de dashboard/formularios se derivan siempre de `meeting_invitations`/`meeting_attendance`/`form_submissions` en consulta |
| Única ruta de escritura + centinela | Un módulo por operación sensible (check-in, cambios de estado de invitación, alta desde formulario, auditoría), con test que falla si otra ruta escribe esas tablas |
| Resolver alcance en un solo lugar | `lib/scope/resolve.ts` es el único traductor de "quién puede ver qué" a filtro de consulta; lo usan grilla, exportación, conteo previo y generación de invitaciones por igual |
| Tope silencioso de 1000 filas | No aplica directamente (D2 usa Postgres directo sin PostgREST), pero se mantiene la disciplina: agregaciones en SQL, nunca traer miles de filas a Node para procesarlas |
| Vencidas no pasan solas a realizadas | Reuniones con fecha pasada quedan "vencida sin cerrar" hasta que alguien las finalice o cancele explícitamente |
| Desactivar en vez de borrar | Personas, usuarios, formularios y reuniones con historial nunca se borran físicamente (R8) |
| Filtros con texto del usuario | Toda consulta usa parámetros tipados; ninguna concatenación de input de usuario en SQL |
| Errores de base al navegador | Mensaje genérico al cliente + log server-side con ID de correlación |
| Build antes de restart | Mismo criterio para el script de actualización, cuando exista despliegue (fuera de esta etapa) |

## 11. Riesgos heredados de la Etapa 0 y cómo se resuelven acá

Ver detalle en el reporte de la Etapa 0 (chat). Resumen de resolución:

1. Snapshot de sesión que no se invalida → resuelto con `permissions_version` (D4).
2. FKs `SET NULL` frágiles → SUTECBA usa `RESTRICT`/`NO ACTION` en FKs hacia entidades con historial (R8), documentado en detalle en `SUTECBA_DATABASE.md` (Etapa 2).
3. Rate limit en memoria de proceso → movido a tabla (D4, D13).
4. Falta de test que verifique que toda Server Action llama al guard de permisos → se agrega como test centinela en la Etapa 3/10.
5. Riesgo de memoria de build en VPS compartido → documentado en `docs/despliegue.md` (Etapa 19), sin acción hasta que haya despliegue real.

## Pendientes explícitos

- Confirmar si la base definitiva será Supabase Cloud, otro Postgres administrado, o se queda en el VPS del usuario — hoy se trabaja 100% local.
- Confirmar si el MVP necesita mapa (sedes/delegaciones) antes de decidir si se instala Leaflet.
- Validación legal de R7 (afiliación sindical como dato sensible) — recomendación en `docs/datos-personales.md` (Etapa 19), no resuelta por diseño de software.
