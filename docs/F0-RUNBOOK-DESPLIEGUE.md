# F0 — Runbook de despliegue a producción

**Estado: PREPARADO, NO AUTORIZADO.** Nada de lo que sigue se ejecuta sin la autorización expresa del titular. Lo ejecuta el titular (o quien él indique), **un paso por vez**, pegando
la salida de cada paso de verificación antes de continuar. Cada paso tiene **Esperado** y, si no coincide, **DETENER**: no se improvisa ni se reintenta a ciegas.

| | |
|---|---|
| Repositorio | `Facunfer/crmsutec` · rama `master` |
| Commit actual en producción | `553ab60` |
| Commit a desplegar | el commit exclusivo de F0 (hash a completar cuando se cree) |
| Migraciones nuevas | `0046_public_link_attempts_hardening.sql`, `0047_meetings_accredit_permission.sql` (las únicas) |
| VPS · app | `/opt/sutecba` · nginx → `127.0.0.1:3100` · `https://sutecba.duckdns.org` |
| PM2 | `sutecba` (web: `npm run start -- -H 127.0.0.1` → `next start -p 3100`) · `sutecba-mail` (worker de Mailing) |
| Servicio que se reinicia | **solo `sutecba`** |
| Lo que NO se toca | nginx, firewall, `.env`, variables del VPS, `sutecba-mail`, **cualquier otra aplicación del VPS** (incluida la que escucha en el puerto 3000), datos históricos |

Dependencias nuevas: **ninguna** (`package.json` y `package-lock.json` no cambian) → no se ejecuta `npm install`/`npm ci`.
Documentos hermanos: `docs/F0-RUNBOOK-ROLLBACK.md` (qué hacer si algo falla) y `docs/F0-PREFLIGHT-VPS-PROCEDIMIENTO.md` (bloques A–D del preflight de infraestructura).

---

## Por qué este orden (y cómo se evitan inconsistencias código ↔ esquema)

1. **Publicar el commit → `git pull --ff-only` en el VPS.** Solo cambian archivos de código en disco. El servidor que está corriendo sirve la build ya compilada en `.next`, no lee el código fuente, así que el pull **no afecta** al servicio actual. `sutecba-mail` ya cargó su código en memoria (el worker no importa módulos que cambien su comportamiento; Mailing no cambia).
2. **Migrar ANTES de compilar y reiniciar.** El esquema nuevo es **compatible hacia atrás**: el código viejo (`553ab60`) funciona sobre las migraciones 0046/0047 (se corrió la suite completa de `553ab60` contra el esquema nuevo: 1139 pruebas pasan). El código nuevo, en cambio, **necesita** el esquema: sin la 0047 el permiso `meetings.accredit` no existe y nadie —ni MASTER_GLOBAL— podría emitir el QR. Por eso: esquema primero, código después ⇒ **no hay ningún instante** con código nuevo sobre esquema viejo.
3. **Cada migración es una transacción** que incluye su propio registro en `sutecba_migrations`: o se aplica entera o no deja nada. La 0046 además se **verifica a sí misma** (dueño, `SECURITY DEFINER`, grantees exactos) y aborta si algo no cuadra.
4. **Chequeo de arranque previo al reinicio** (paso 2.4): reproduce lo que hará el servidor con el `.env` real. Con un `SUTECBA_QR_SECRET` ausente o menor de 32 caracteres el sitio **no cae del proceso: queda «online» en PM2 pero responde 500 en TODAS las rutas** (comportamiento verificado con la build). Por eso se comprueba antes y se verifica HTTP inmediatamente después.
5. **Compilar y reiniciar seguidos.** `next build` reescribe `.next` mientras el proceso viejo sigue sirviendo; hay que reiniciar enseguida. Hay copia de `.next` para volver sin recompilar.
6. **Reiniciar solo `sutecba`.** El worker puede seguir con su código en memoria (compatible); no se interrumpe ningún envío.

Si algo falla después de migrar pero antes de reiniciar, **el sitio sigue sirviendo con el código viejo sobre el esquema nuevo** (compatible): se corrige o se hace rollback de código con calma.

---

## PARTE 0 — Variables y guarda (siempre primero, en CADA sesión SSH)

```bash
export EXPECTED_HOST="<hostname-del-VPS-de-SUTECBA>"
export APP_DIR=/opt/sutecba
export APP_NAME=sutecba
export WORKER_NAME=sutecba-mail
export APP_PORT=3100
export BASE_URL=https://sutecba.duckdns.org
[ "$(hostname)" = "$EXPECTED_HOST" ] && echo "HOST OK: $(hostname)" || echo "HOST EQUIVOCADO ($(hostname)) → PARAR"
cd "$APP_DIR" && pwd
```
**Esperado:** `HOST OK` y `/opt/sutecba`. **Si no:** DETENER (el VPS es compartido).

Ejecutor de consultas de solo lectura (transacción `READ ONLY`, rechaza cualquier escritura, no imprime la URL de la base):
```bash
cat > /tmp/f0-readonly.cjs <<'F0RUNNER'
// Ejecuta consultas de SOLO LECTURA (transacción READ ONLY) y las imprime como JSON. No escribe nada y nunca imprime la URL.
//   node /tmp/f0-readonly.cjs <carpeta-de-la-app> <archivo.sql>      (consultas separadas por líneas «-- @@»)
const fs = require("fs");
const path = require("path");
const [appDirArg, sqlFile] = process.argv.slice(2);
const appDir = appDirArg && path.resolve(appDirArg);
if (!appDirArg || !sqlFile) throw new Error("Uso: node f0-readonly.cjs <carpeta-de-la-app> <archivo.sql>");
const { Pool } = require(path.join(appDir, "node_modules", "pg"));
const envText = fs.readFileSync(path.join(appDir, ".env"), "utf8");
const m = envText.match(/^\s*SUTECBA_MIGRATION_DATABASE_URL\s*=\s*(.*)$/m);
if (!m) throw new Error("Falta SUTECBA_MIGRATION_DATABASE_URL en .env");
const url = m[1].trim().replace(/^["']|["']$/g, "");
const statements = fs.readFileSync(sqlFile, "utf8").split(/^-- @@.*$/m).map((s) => s.trim()).filter(Boolean);
for (const s of statements) {
  const sinTextos = s.replace(/'[^']*'/g, "''").replace(/--.*$/gm, "");
  if (/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|do|vacuum|reindex|set|reset)\b/i.test(sinTextos)) {
    throw new Error("Sentencia no permitida (solo lectura): " + s.slice(0, 70));
  }
}
(async () => {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await pool.query("set default_transaction_read_only = on");
    await pool.query("begin isolation level repeatable read read only");
    for (const [i, s] of statements.entries()) {
      const titulo = (s.match(/^--\s*(.*)$/m) || [])[1] || "";
      const r = await pool.query(s);
      console.log(JSON.stringify({ consulta: i + 1, titulo, filas: r.rows.length, resultado: r.rows }, null, 2));
    }
    await pool.query("rollback");
  } catch (e) {
    console.error("ERROR:", String(e.message).replace(/postgres(ql)?:\/\/\S+/gi, "[url]"));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
F0RUNNER

cat > /tmp/f0-pre.sql <<'F0PRE'
-- P1 · identidad de la conexión y versión
SELECT current_database() AS base, current_user AS rol, split_part(version(), ' on ', 1) AS version
-- @@
-- P2 · migraciones: la última aplicada debe ser 0045 y 0046/0047 NO deben figurar (aplicadas_46_47 = 0)
SELECT (SELECT max(filename) FROM sutecba_migrations) AS ultima, (SELECT count(*) FROM sutecba_migrations)::int AS total, (SELECT count(*) FROM sutecba_migrations WHERE filename IN ('0046_public_link_attempts_hardening.sql', '0047_meetings_accredit_permission.sql'))::int AS aplicadas_46_47
-- @@
-- P3 · Mailing: no debe haber trabajo en curso ni pendiente (todo debe ser 0; en «worker» se espera 1 si sutecba-mail está online)
SELECT 'campañas scheduled/sending/paused' AS item, count(*)::int AS n FROM mailing_campaigns WHERE status IN ('scheduled', 'sending', 'paused')
UNION ALL SELECT 'destinatarios queued/sending/send_unknown', count(*)::int FROM mailing_campaign_recipients WHERE status IN ('queued', 'sending', 'send_unknown')
UNION ALL SELECT 'lotes pending/running', count(*)::int FROM mailing_campaign_batches WHERE status IN ('pending', 'running')
UNION ALL SELECT 'worker con latido en los últimos 2 minutos', count(*)::int FROM mailing_worker_heartbeats WHERE last_seen_at > now() - interval '2 minutes'
-- @@
-- P4 · F0 todavía no aplicada: el permiso no existe y los objetos de la 0046 tampoco
SELECT (SELECT count(*) FROM permissions WHERE key = 'meetings.accredit')::int AS permiso_accredit, to_regprocedure('public.purge_public_link_attempts(integer)') IS NOT NULL AS funcion_purga, to_regclass('public.public_link_attempts_created_at_idx') IS NOT NULL AS indice_created_at
-- @@
-- P5 · línea de base de integridad (GUARDAR esta salida: se compara con Q5 del postdeploy)
SELECT 'people' AS tabla, count(*)::int AS filas FROM people
UNION ALL
SELECT 'people_associations' AS tabla, count(*)::int AS filas FROM people_associations
UNION ALL
SELECT 'meeting_participations' AS tabla, count(*)::int AS filas FROM meeting_participations
UNION ALL
SELECT 'meeting_invitations' AS tabla, count(*)::int AS filas FROM meeting_invitations
UNION ALL
SELECT 'meeting_attendance' AS tabla, count(*)::int AS filas FROM meeting_attendance
UNION ALL
SELECT 'meetings' AS tabla, count(*)::int AS filas FROM meetings
UNION ALL
SELECT 'person_interactions' AS tabla, count(*)::int AS filas FROM person_interactions
UNION ALL
SELECT 'organizations' AS tabla, count(*)::int AS filas FROM organizations
UNION ALL
SELECT 'associations' AS tabla, count(*)::int AS filas FROM associations
UNION ALL
SELECT 'forms' AS tabla, count(*)::int AS filas FROM forms
UNION ALL
SELECT 'form_submissions' AS tabla, count(*)::int AS filas FROM form_submissions
UNION ALL
SELECT 'users' AS tabla, count(*)::int AS filas FROM users
UNION ALL
SELECT 'sessions' AS tabla, count(*)::int AS filas FROM sessions
UNION ALL
SELECT 'mailing_campaigns' AS tabla, count(*)::int AS filas FROM mailing_campaigns
UNION ALL
SELECT 'mailing_campaign_recipients' AS tabla, count(*)::int AS filas FROM mailing_campaign_recipients
UNION ALL
SELECT 'mailing_events' AS tabla, count(*)::int AS filas FROM mailing_events
UNION ALL
SELECT 'mailing_suppressions' AS tabla, count(*)::int AS filas FROM mailing_suppressions
UNION ALL
SELECT 'role_permissions' AS tabla, count(*)::int AS filas FROM role_permissions
UNION ALL
SELECT 'permissions' AS tabla, count(*)::int AS filas FROM permissions
UNION ALL
SELECT 'public_link_attempts' AS tabla, count(*)::int AS filas FROM public_link_attempts
ORDER BY 1
-- @@
-- P6 · formularios fuera de alcance (esperado: 0 filas) — mismo criterio que el bloque C del procedimiento
SELECT count(*)::int AS acciones_de_asociacion_fuera_de_alcance FROM (
  SELECT fa.id FROM form_actions fa JOIN forms f ON f.id = fa.form_id
  WHERE fa.action_type = 'add_to_association'
    AND NOT EXISTS (SELECT 1 FROM associations a WHERE a.id::text = fa.config->>'associationId' AND a.status = 'active'
      AND a.owner_organization_id IN (SELECT organization_id FROM organization_descendants(f.owner_organization_id)))) x
F0PRE

cat > /tmp/f0-post.sql <<'F0POST'
-- Q1 · migraciones: las últimas deben ser 0047, 0046, 0045
SELECT filename FROM sutecba_migrations ORDER BY filename DESC LIMIT 3
-- @@
-- Q2 · la función de limpieza: SOLO sutecba_app (y el dueño) puede ejecutarla (esperado: sutecba_app=true, el resto=false)
SELECT r AS rol, has_function_privilege(r, 'public.purge_public_link_attempts(integer)', 'EXECUTE') AS puede_ejecutar
FROM unnest(ARRAY['sutecba_app', 'anon', 'authenticated', 'service_role']) AS r WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) ORDER BY 1
-- @@
-- Q3 · ACL real de la función (esperado: dueño y sutecba_app, ningún otro, sin PUBLIC) y modo
SELECT p.prosecdef AS security_definer, pg_get_userbyid(p.proowner) AS dueno, array_to_string(p.proconfig, ',') AS config,
  (SELECT string_agg(CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END, ', ' ORDER BY 1) FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE') AS con_execute
FROM pg_proc p WHERE p.oid = 'public.purge_public_link_attempts(integer)'::regprocedure
-- @@
-- Q4 · privilegios de sutecba_app sobre la tabla de intentos (esperado: UPDATE solo en succeeded; sin DELETE ni TRUNCATE)
SELECT has_table_privilege('sutecba_app', 'public.public_link_attempts', 'SELECT') AS select_ok, has_table_privilege('sutecba_app', 'public.public_link_attempts', 'INSERT') AS insert_ok,
  has_table_privilege('sutecba_app', 'public.public_link_attempts', 'DELETE') AS delete_debe_ser_false, has_table_privilege('sutecba_app', 'public.public_link_attempts', 'TRUNCATE') AS truncate_debe_ser_false,
  has_column_privilege('sutecba_app', 'public.public_link_attempts', 'succeeded', 'UPDATE') AS update_succeeded_ok,
  has_column_privilege('sutecba_app', 'public.public_link_attempts', 'identifier', 'UPDATE') AS update_identifier_debe_ser_false
-- @@
-- Q5 · integridad: MISMA consulta que P5. Comparar con la línea de base: solo pueden cambiar permissions (+1), role_permissions (+4), public_link_attempts (las pruebas) y lo que haya hecho el uso normal (sessions, form_submissions)
SELECT 'people' AS tabla, count(*)::int AS filas FROM people
UNION ALL
SELECT 'people_associations' AS tabla, count(*)::int AS filas FROM people_associations
UNION ALL
SELECT 'meeting_participations' AS tabla, count(*)::int AS filas FROM meeting_participations
UNION ALL
SELECT 'meeting_invitations' AS tabla, count(*)::int AS filas FROM meeting_invitations
UNION ALL
SELECT 'meeting_attendance' AS tabla, count(*)::int AS filas FROM meeting_attendance
UNION ALL
SELECT 'meetings' AS tabla, count(*)::int AS filas FROM meetings
UNION ALL
SELECT 'person_interactions' AS tabla, count(*)::int AS filas FROM person_interactions
UNION ALL
SELECT 'organizations' AS tabla, count(*)::int AS filas FROM organizations
UNION ALL
SELECT 'associations' AS tabla, count(*)::int AS filas FROM associations
UNION ALL
SELECT 'forms' AS tabla, count(*)::int AS filas FROM forms
UNION ALL
SELECT 'form_submissions' AS tabla, count(*)::int AS filas FROM form_submissions
UNION ALL
SELECT 'users' AS tabla, count(*)::int AS filas FROM users
UNION ALL
SELECT 'sessions' AS tabla, count(*)::int AS filas FROM sessions
UNION ALL
SELECT 'mailing_campaigns' AS tabla, count(*)::int AS filas FROM mailing_campaigns
UNION ALL
SELECT 'mailing_campaign_recipients' AS tabla, count(*)::int AS filas FROM mailing_campaign_recipients
UNION ALL
SELECT 'mailing_events' AS tabla, count(*)::int AS filas FROM mailing_events
UNION ALL
SELECT 'mailing_suppressions' AS tabla, count(*)::int AS filas FROM mailing_suppressions
UNION ALL
SELECT 'role_permissions' AS tabla, count(*)::int AS filas FROM role_permissions
UNION ALL
SELECT 'permissions' AS tabla, count(*)::int AS filas FROM permissions
UNION ALL
SELECT 'public_link_attempts' AS tabla, count(*)::int AS filas FROM public_link_attempts
ORDER BY 1
-- @@
-- Q6 · permiso meetings.accredit: esperado ADMIN, MASTER_GLOBAL, OPERADOR, REUNIONES (y no LECTURA)
SELECT r.key AS rol FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id WHERE p.key = 'meetings.accredit' ORDER BY 1
-- @@
-- Q7 · intentos públicos: ningún token en claro (a_sanear = 0) y últimos registros (identificador solo prefijo; IP y resultado)
SELECT (SELECT count(*) FROM public_link_attempts WHERE scope IN ('invitation_view', 'invitation_respond', 'invitation_checkin', 'checkin_qr') AND identifier NOT LIKE 'h1:%')::int AS a_sanear,
  (SELECT count(*) FROM public_link_attempts)::int AS filas
-- @@
-- Q8 · últimos 5 intentos: la IP debe ser la REAL del cliente (jamás la que se escribió en X-Forwarded-For), el identificador empieza con h1:
SELECT scope, left(identifier, 3) AS prefijo_id, length(identifier)::int AS largo_id, host(ip_address) AS ip, succeeded, to_char(created_at AT TIME ZONE 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD HH24:MI:SS') AS hora
FROM public_link_attempts ORDER BY created_at DESC LIMIT 5
-- @@
-- Q10 · prueba de IP efectiva (los curl con X-Forwarded-For falso de los últimos 20 minutos): debe haber UNA sola IP, la real de quien probó; ninguna 6.6.6.6 ni 9.9.9.x
SELECT host(ip_address) AS ip, scope, count(*)::int AS intentos, count(*) FILTER (WHERE succeeded)::int AS exitosos
FROM public_link_attempts WHERE created_at > now() - interval '20 minutes' GROUP BY 1, 2 ORDER BY 3 DESC
-- @@
-- Q9 · Mailing sin cambios: los mismos conteos que P3 y que P5 (no debe haber envíos nuevos por el despliegue)
SELECT 'campañas scheduled/sending/paused' AS item, count(*)::int AS n FROM mailing_campaigns WHERE status IN ('scheduled', 'sending', 'paused')
UNION ALL SELECT 'destinatarios queued/sending/send_unknown', count(*)::int FROM mailing_campaign_recipients WHERE status IN ('queued', 'sending', 'send_unknown')
UNION ALL SELECT 'eventos de mailing', count(*)::int FROM mailing_events
UNION ALL SELECT 'worker con latido en los últimos 2 minutos', count(*)::int FROM mailing_worker_heartbeats WHERE last_seen_at > now() - interval '2 minutes'
F0POST
```

---

## PARTE 1 — PREDEPLOY (solo lectura salvo copias de respaldo)

### 1.1 Commit actual en producción y estado de Git
```bash
cd "$APP_DIR"
git rev-parse --short HEAD ; git branch --show-current
git status --porcelain ; echo "--- (vacío = árbol limpio) ---"
git log -1 --format='%h %s'
```
**Esperado:** `553ab60`, rama `master`, **árbol limpio** (sin salida entre las líneas), último commit «feat(mailing): sin referencias al costo del envío…».
**Si hay archivos modificados/sin trackear** (por ejemplo logs o copias): anotarlos y confirmar que el pull no los pisa. Si hay cambios sobre archivos versionados → **DETENER** y decidir con el titular.

### 1.2 `origin/master` contiene exactamente el commit de F0 y solo los archivos aprobados
```bash
git fetch origin                                   # solo actualiza referencias; no toca el árbol de trabajo
git log --oneline HEAD..origin/master              # debe listar UN commit: el de F0
git diff --name-only HEAD origin/master | sort > /tmp/f0-remote-files.txt
cat > /tmp/f0-expected-files.txt <<'F0FILES'
.env.example
SUTECBA_CONTEXTO.md
SUTECBA_SEGURIDAD.md
app/(protegido)/reuniones/[id]/asistencia/page.tsx
app/(protegido)/reuniones/[id]/page.tsx
app/api/reuniones/[id]/live/route.ts
app/api/reuniones/[id]/qr/route.ts
app/api/unsubscribe/[token]/route.ts
app/f/[slug]/FormRenderer.tsx
app/f/[slug]/actions.ts
app/f/[slug]/page.tsx
app/login/actions.ts
app/login/cambiar-contrasena/actions.ts
app/reunion/checkin/[qrToken]/route.ts
app/reunion/checkin/actions.ts
app/reunion/invitacion/[token]/actions.ts
app/reunion/invitacion/[token]/page.tsx
app/unsubscribe/[token]/page.tsx
db/migrations/0046_public_link_attempts_hardening.sql
db/migrations/0047_meetings_accredit_permission.sql
docs/F0-CIERRE-AUDITORIA-FINAL.md
docs/F0-NGINX-PROPUESTA.md
docs/F0-PREFLIGHT-VPS-PROCEDIMIENTO.md
docs/F0-RUNBOOK-DESPLIEGUE.md
docs/F0-RUNBOOK-ROLLBACK.md
docs/F0-SEGURIDAD-INFORME-Y-DESPLIEGUE.md
instrumentation.ts
lib/attendance/checkin.ts
lib/attendance/live.ts
lib/attendance/qr-config.ts
lib/attendance/qr.ts
lib/attendance/session-tokens.ts
lib/db/env.ts
lib/forms/apply.ts
lib/forms/commands.ts
lib/forms/duplicates.ts
lib/forms/queries.ts
lib/forms/submissions.ts
lib/forms/submit.ts
lib/mailing/unsubscribe-limit.ts
lib/meetings/public.ts
lib/permissions/catalog.ts
lib/security/client-ip.ts
lib/security/public-rate-limit.ts
lib/security/request-ip.ts
lib/security/text-safety.ts
scripts/preflight-f0.ts
scripts/verify-f0-copy.ts
tests/centinela/surface-behavior.test.ts
tests/integration/f0-security.test.ts
tests/integration/forms.test.ts
tests/integration/mailing.test.ts
tests/integration/pglite-local.test.ts
tests/integration/preflight-f0.test.ts
tests/integration/public-endpoints-f0.test.ts
tests/integration/verify-f0-copy.test.ts
tests/unit/client-ip.test.ts
tests/unit/permission-modules.test.ts
tests/unit/qr-config.test.ts
F0FILES
diff /tmp/f0-remote-files.txt /tmp/f0-expected-files.txt && echo "COINCIDE: se desplegarán exactamente los 59 archivos aprobados"
git diff --name-only HEAD origin/master | grep -E "^(package(-lock)?\.json|\.env($|\.local|\.production)|db/migrations/00(0[1-9]|[1-3][0-9]|4[0-5])_)" && echo "ALERTA: archivo no previsto" || echo "sin cambios en dependencias, .env ni migraciones previas"
git diff --diff-filter=A --name-only HEAD origin/master -- db/migrations
```
**Esperado:** un único commit; `diff` sin diferencias; «sin cambios en dependencias, .env ni migraciones previas»; y las **dos** migraciones nuevas (`0046…`, `0047…`) como únicas altas.
**Si no coincide:** DETENER (se publicó algo distinto de lo aprobado).

### 1.3 Respaldo verificable de PostgreSQL/Supabase y prueba de restaurabilidad
Se hace **desde el equipo que tiene el repositorio** (como en los despliegues anteriores), no en el VPS. Es lectura de la base; las carpetas quedan **fuera del repositorio**.
```bash
# (a) respaldo lógico: un JSON por tabla + MANIFEST con filas y SHA-256; releé cada archivo para verificar
npm run backup:logical -- --out-dir "C:\Users\usuario\Documents\sutecba-fuentes\backups" --label pre-f0
# (b) restaurabilidad: restaura en un PGlite temporal (nunca en producción) y compara tabla por tabla
npx tsx scripts/restore-logical-backup.ts --backup "<carpeta que imprimió (a)>" --extra-migrations-from none
```
**Esperado (a):** exit 0 y una carpeta con `MANIFEST.json` (anotar el total de tablas y las filas de `people`).
**Esperado (b):** `archivos_vs_manifest: "OK …"`, `tablas_no_restauradas: []`, `tablas_identicas_fila_por_fila: "N de N"`, `tablas_con_diferencias: []`, `conteos_criticos` iguales.
**Además (manual, no automatizable):** en el panel de Supabase, confirmar que existe un respaldo diario/PITR **posterior a hoy 00:00**. Anotar la hora.
**Si algo no coincide:** DETENER. Sin respaldo verificado no se migra.

### 1.4 Ensayo de las migraciones sobre la copia fresca (opcional pero recomendado)
```bash
npx tsx scripts/restore-logical-backup.ts --backup "<carpeta de 1.3>" --keep
npx tsx scripts/verify-f0-copy.ts --data-dir "<…\sutecba-restore-XXXX\pglite>" --backup "<carpeta de 1.3>"
```
**Esperado:** `migraciones_aplicadas_sobre_la_copia` = exactamente 0046 y 0047, 64+ tablas idénticas, y `RESUMEN: N/N PASS, 0 FAIL → PASS`. Después borrar la copia temporal y la carpeta del respaldo si ya no se necesita (contienen datos personales).

### 1.5 Respaldo del build actual y espacio en disco
```bash
cd "$APP_DIR"
df -h "$APP_DIR" | tail -1 ; du -sh .next
cat .next/BUILD_ID | tee /root/f0-prev-build-id.txt
cp -a .next .next.pre-f0-553ab60 && echo "copia de .next creada"
ls -d .next.pre-f0-553ab60 && cat .next.pre-f0-553ab60/BUILD_ID
```
**Esperado:** espacio libre al menos 3 × el tamaño de `.next`; ambos `BUILD_ID` idénticos. **Si el espacio no alcanza:** DETENER.

### 1.6 Línea de base de PM2 (no se modifica nada)
```bash
pm2 ls
for n in "$APP_NAME" "$WORKER_NAME"; do echo "=== $n ==="; pm2 describe "$n" | grep -E "status|restarts|uptime|script path|script args|exec cwd|pid path" ; done
pm2 pid "$APP_NAME" ; pm2 pid "$WORKER_NAME"
pm2 ls > /tmp/f0-pm2-before.txt
```
**Esperado:** `sutecba` y `sutecba-mail` en `online`; `exec cwd` = `/opt/sutecba`; **anotar** `restarts` y `uptime` de ambos y de toda otra aplicación que liste `pm2 ls` (al final deben conservar su uptime: solo `sutecba` se reinicia).
**Si alguno no está `online`:** DETENER y resolver antes.

### 1.7 Mailing: nada en curso ni pendiente
```bash
node /tmp/f0-readonly.cjs "$APP_DIR" /tmp/f0-pre.sql | tee /tmp/f0-pre.json
```
Mirar la consulta **P3**. **Esperado:** `campañas scheduled/sending/paused = 0`, `destinatarios queued/sending/send_unknown = 0`, `lotes pending/running = 0`; `worker con latido… = 1` (el worker vivo y ocioso).
**Si hay trabajo en curso:** NO desplegar; esperar a que termine (F0 no reinicia el worker, pero se exige una ventana quieta).
`MAIL_PROVIDER=resend` se mantiene: **no se toca ninguna variable de Mailing y no se envía nada**.

### 1.8 Variables de entorno
Ejecutar los comandos del **bloque B** de `docs/F0-PREFLIGHT-VPS-PROCEDIMIENTO.md` (largo del secreto sin imprimirlo). **Esperado:** `SUTECBA_QR_SECRET` definido, **largo ≥ 32** (hoy 43), `SUTECBA_ENV=production`, sin `SUTECBA_QR_DISABLED`, sin `SUTECBA_TRUSTED_PROXY_HOPS` (se usa el predeterminado **1**, correcto para nginx con `$proxy_add_x_forwarded_for` y un único proxy). **No se modifica ninguna variable.**

### 1.9 Las migraciones 0046 y 0047 todavía NO están aplicadas
Consultas **P2**, **P4** y **P6** de `/tmp/f0-pre.json`. **Esperado:** `ultima = 0045_mailing_provider_resend.sql`, `aplicadas_46_47 = 0`, `permiso_accredit = 0`, `funcion_purga = false`, `indice_created_at = false`, `acciones_de_asociacion_fuera_de_alcance = 0`.
**Guardar** la salida de **P5** (línea de base de integridad): se compara con la del postdeploy.
**Si 0046/0047 ya figuran:** DETENER (alguien migró antes; entender por qué).

### 1.10 Lista de control de entrada (todas deben estar en SÍ)
| ✔ | Condición |
|---|---|
| ☐ | 1.1 `553ab60`, árbol limpio |
| ☐ | 1.2 el remoto coincide con los 59 archivos aprobados |
| ☐ | 1.3 respaldo verificado + restaurabilidad OK + respaldo de Supabase confirmado |
| ☐ | 1.5 copia de `.next` y espacio suficiente |
| ☐ | 1.6 PM2 `online` y línea de base anotada |
| ☐ | 1.7 Mailing sin trabajo en curso |
| ☐ | 1.8 secreto de QR ≥ 32, `SUTECBA_ENV=production` |
| ☐ | 1.9 0046/0047 no aplicadas |
| ☐ | Bloques A y B del procedimiento de preflight en PASS (nginx/IP/puerto; secreto) |
| ☐ | Ventana de bajo tráfico acordada; autorización expresa del titular para desplegar |

---

## PARTE 2 — DEPLOY

> Tiempo estimado: 15–25 minutos. Si un paso no da lo **Esperado**: DETENER y consultar `docs/F0-RUNBOOK-ROLLBACK.md` (no seguir al paso siguiente).

### 2.1 Publicar el commit aprobado (previo, en el equipo de desarrollo)
Solo con autorización expresa: `git push origin master` del commit exclusivo de F0. Verificar con `git log origin/master -1`.

### 2.2 Actualizar el repositorio en el VPS
```bash
cd "$APP_DIR"
git pull --ff-only
git rev-parse --short HEAD ; git log -1 --format='%h %s'
git status --porcelain ; echo "--- (vacío = limpio) ---"
git diff --name-only 553ab60 HEAD -- package.json package-lock.json | wc -l
```
**Esperado:** `HEAD` = el commit de F0 (`security: harden public forms, QR accreditation and rate limiting (F0)`), árbol limpio, y `0` archivos de dependencias cambiados (no se ejecuta `npm install`). El servicio sigue sirviendo sin cambios (usa `.next`).
**Si `pull` no es fast-forward o falla:** DETENER (no usar `--force`, `reset` ni `merge`).

### 2.3 Chequeo previo de arranque con el `.env` real (no arranca nada)
```bash
cat > /tmp/f0-boot-check.ts <<'F0BOOT'
// Reproduce lo que hará el servidor al arrancar, SIN arrancarlo: carga los .env como Next (modo producción, con la prioridad real) y aplica
// EXACTAMENTE assertQrConfigAtBoot. Solo lectura. No imprime el secreto (solo estado y largo).
//   npx tsx /tmp/f0-boot-check.ts <carpeta-de-la-app>
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const appDir = path.resolve(process.argv[2] ?? process.cwd());
const requireFromApp = createRequire(path.join(appDir, "package.json"));
const { loadEnvConfig } = requireFromApp("@next/env") as { loadEnvConfig: (dir: string, dev?: boolean) => unknown };
process.chdir(appDir);
loadEnvConfig(appDir, false); // false = modo producción: .env.production.local, .env.local, .env.production, .env (el entorno del proceso gana)

const load = (rel: string) => import(pathToFileURL(path.join(appDir, rel)).href);
const { assertQrConfigAtBoot, qrConfigStatus, QR_SECRET_MIN_LENGTH } = await load("lib/attendance/qr-config.ts");
const { trustedProxyHops } = await load("lib/security/client-ip.ts");

const e = process.env;
console.log(`SUTECBA_ENV=${e.SUTECBA_ENV ?? "(sin definir)"} · SUTECBA_QR_DISABLED=${e.SUTECBA_QR_DISABLED ?? "(sin definir)"} · SUTECBA_TRUSTED_PROXY_HOPS efectivo=${trustedProxyHops()}`);
const status = qrConfigStatus();
console.log(
  "SUTECBA_QR_SECRET:",
  status.state === "ok" ? `definido, largo ${e.SUTECBA_QR_SECRET!.length} (mínimo ${QR_SECRET_MIN_LENGTH}) → OK` : status.state === "disabled" ? "QR deshabilitado explícitamente" : `INVÁLIDO (${status.reason})`
);
try {
  assertQrConfigAtBoot();
  if (e.SUTECBA_ENV === "production") console.log("RESULTADO: PASS — el chequeo de arranque pasará.");
  else console.log("RESULTADO: AVISO — SUTECBA_ENV no es «production» en este entorno: el chequeo de arranque NO se aplicaría (revisar el .env del VPS).");
} catch (err) {
  console.log("RESULTADO: BLOCKER —", (err as Error).message);
  process.exitCode = 2;
}
F0BOOT
cd "$APP_DIR" && npx tsx /tmp/f0-boot-check.ts "$APP_DIR"
```
**Esperado:** `SUTECBA_ENV=production · … TRUSTED_PROXY_HOPS efectivo=1`, `SUTECBA_QR_SECRET: definido, largo N (mínimo 32) → OK`, y `RESULTADO: PASS — el chequeo de arranque pasará.`
**Si dice `BLOCKER`:** DETENER (**antes** de migrar o reiniciar). Corregir el `.env` es una decisión del titular; no se imprime ni se rota el secreto vigente.

### 2.4 Aplicar las migraciones (controlado)
```bash
cd "$APP_DIR"
npm run migrate -- --yes 2>&1 | tee /tmp/f0-migrate.log
```
**Esperado (texto):**
```
[migrate] destino: … (conexión de migraciones)
[migrate] aplicando 0046_public_link_attempts_hardening.sql...
[migrate] 0046_public_link_attempts_hardening.sql OK
[migrate] aplicando 0047_meetings_accredit_permission.sql...
[migrate] 0047_meetings_accredit_permission.sql OK
[migrate] listo. 2 migración(es) aplicada(s).
```
Las guardas de producción exigen `--yes` y verifican la identidad de la base. Cada migración es **una transacción** con su registro.
**Si falla:** NO reintentar. Ver «Rollback → Migración fallida» (estado y causa antes de cualquier acción). Un mensaje que empieza con `0046:` es la verificación interna de permisos (nombra el rol o el dueño que no cuadra).

### 2.5 Verificar el esquema recién migrado (solo lectura)
```bash
node /tmp/f0-readonly.cjs "$APP_DIR" /tmp/f0-post.sql | tee /tmp/f0-post.json
```
Revisar **Q1, Q2, Q3, Q4, Q6, Q7**. **Esperado:**
- **Q1** últimas: `0047…`, `0046…`, `0045…`.
- **Q2** `sutecba_app = true`; `anon`, `authenticated`, `service_role = false`.
- **Q3** `security_definer = true`, `dueno = postgres`, `config = search_path=public, pg_temp`, `con_execute = postgres, sutecba_app`.
- **Q4** `select_ok`/`insert_ok`/`update_succeeded_ok = true`; `delete_debe_ser_false`, `truncate_debe_ser_false`, `update_identifier_debe_ser_false = false`.
- **Q6** `ADMIN`, `MASTER_GLOBAL`, `OPERADOR`, `REUNIONES` (y **no** `LECTURA`).
- **Q7** `a_sanear = 0`.
**Si algo difiere:** DETENER (el sitio sigue sano con el código viejo; no se compila ni reinicia).

### 2.6 Compilar el nuevo build
```bash
cd "$APP_DIR"
set -o pipefail
npm run build 2>&1 | tee /tmp/f0-build.log ; echo "BUILD_EXIT=${PIPESTATUS[0]}"
cat .next/BUILD_ID ; ls .next/server/instrumentation.js
```
**Esperado:** `BUILD_EXIT=0`, `✓ Compiled successfully`, un `BUILD_ID` **distinto** del anotado en 1.5, y existe `.next/server/instrumentation.js`.
**Si el build falla:** el servicio viejo sigue en pie, pero `.next` puede haber quedado a medias → restaurar la copia (`Rollback → Build fallido`) **antes** de cualquier otra cosa.
**Siguiente paso INMEDIATAMENTE** (el proceso viejo está sirviendo una build que acaba de ser reemplazada).

### 2.7 Reiniciar únicamente `sutecba`
```bash
pm2 restart "$APP_NAME"
sleep 8
pm2 describe "$APP_NAME" | grep -E "status|restarts|uptime"
```
**Esperado:** `status online`, `uptime` de pocos segundos y `restarts` sin saltos. **No** se ejecuta `pm2 restart all` ni se toca `sutecba-mail` ni ninguna otra aplicación.

### 2.8 Verificación inmediata (decide si se sigue o se revierte; máximo 2 minutos)
```bash
for i in 1 2 3 4 5; do curl -s -o /dev/null -w "local /login → %{http_code}\n" http://127.0.0.1:$APP_PORT/login; sleep 1; done
curl -s -o /dev/null -w "público /login → %{http_code}\n" "$BASE_URL/login"
curl -s -o /dev/null -w "público /api/reuniones/…/qr sin sesión → %{http_code}\n" "$BASE_URL/api/reuniones/00000000-0000-4000-8000-000000000000/qr"
pm2 logs "$APP_NAME" --lines 120 --nostream 2>&1 | grep -iE "Failed to prepare|QrConfigError|unhandledRejection|Error:" || echo "sin errores de arranque en el log"
```
**Esperado:** `200` ×5 local, `200` público, `401` en el QR sin sesión y «sin errores de arranque en el log».
**Si hay `500` en cualquier ruta o aparece `Failed to prepare server`/`QrConfigError`:** ROLLBACK DE CÓDIGO **YA** (`docs/F0-RUNBOOK-ROLLBACK.md` §2). El secreto de QR se corrige solo con decisión del titular.

### 2.9 Servicios que NO se tocaron
```bash
pm2 ls > /tmp/f0-pm2-after.txt ; diff /tmp/f0-pm2-before.txt /tmp/f0-pm2-after.txt || true
```
**Esperado:** la única diferencia es la fila de `sutecba` (uptime/restarts/pid/memoria); `sutecba-mail` y cualquier otra aplicación conservan uptime y pid.

---

## PARTE 3 — POSTDEPLOY (verificación funcional)

Las pruebas con `curl` se hacen desde **el equipo del titular** (no desde el VPS) para que la IP registrada sea una IP real de cliente. Generan filas de rastro en `public_link_attempts` (se limpian solas a los 30 días).

### 3.1 Salud de Next.js y PM2
Repetir 2.8 pasados 5 y 30 minutos, y mirar `pm2 describe sutecba` (`restarts` estable) y `pm2 logs sutecba --lines 200 --nostream | grep -ciE "error|exception"` (anotar y revisar cualquier coincidencia).

### 3.2 Rutas protegidas sin sesión
```bash
B=https://sutecba.duckdns.org ; U=00000000-0000-4000-8000-000000000000
for p in "/api/reuniones/$U/qr" "/api/reuniones/$U/live" "/api/personas/export" "/api/formularios/$U/export"; do curl -s -o /dev/null -w "$p → %{http_code}\n" "$B$p"; done
```
**Esperado:** `401` en las cuatro.

### 3.3 IP efectiva y límite de intentos (el ensayo decisivo anti-falsificación)
```bash
B=https://sutecba.duckdns.org
T1=$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 43)
# (a) un cliente que miente en X-Forwarded-For: la página debe responder normalmente
curl -s -H "X-Forwarded-For: 6.6.6.6" "$B/reunion/invitacion/$T1" | grep -c "Este enlace no es válido"
# (b) 36 pedidos al mismo enlace rotando el encabezado falso: el límite (30 por enlace cada 10 min) debe cortar igual
for i in $(seq 1 36); do curl -s -H "X-Forwarded-For: 9.9.9.$i" "$B/reunion/invitacion/$T1" | grep -o -E "Demasiados intentos|Este enlace no es válido"; done | sort | uniq -c
```
**Esperado (a):** `1`. **Esperado (b):** `29` «Este enlace no es válido» y `7` «Demasiados intentos» (el pedido de (a) cuenta: el límite es de 30 por enlace cada 10 minutos). Lo importante: **el límite corta aunque se rote el encabezado** (si no cortara, la IP falsa estaría sirviendo para evadirlo).
Luego, en el VPS, la consulta **Q10** (`node /tmp/f0-readonly.cjs "$APP_DIR" /tmp/f0-post.sql`): **Esperado:** UNA sola IP —la real de quien probó— con `30` intentos en `invitation_view` (los bloqueados no se registran); **ninguna** `6.6.6.6` ni `9.9.9.x`. Y **Q8**: `prefijo_id = h1:`, `largo_id = 35`.
**Si aparece 6.6.6.6 / 9.9.9.x o el límite no corta:** ROLLBACK DE CÓDIGO (la IP está siendo tomada del lado equivocado de la cadena → revisar `SUTECBA_TRUSTED_PROXY_HOPS` y nginx).

### 3.4 Formularios públicos
Hoy hay **0 formularios publicados**: se verifica que las rutas no den errores de servidor.
```bash
B=https://sutecba.duckdns.org
curl -s -o /dev/null -w "formulario inexistente → %{http_code}\n" "$B/f/no-existe-f0"
curl -s "$B/f/no-existe-f0" | grep -c "Este formulario no existe"
curl -s -o /dev/null -w "slug con byte nulo → %{http_code}\n" "$B/f/prueba%00"
```
**Esperado:** `200`/«1»/`200` (nunca `5xx`). Para ejercitar una publicación real (validación de asociaciones, honeypot) hace falta un formulario de prueba: **solo si el titular lo autoriza** y se archiva después (los formularios no se borran).

### 3.5 Invitaciones existentes
Producción tiene **0 invitaciones**: no hay enlaces vigentes que verificar. Se comprueba que un enlace inexistente se maneje con el mensaje de «no válido» (3.3a) sin error. Cuando existan invitaciones reales, el acceso depende de `meeting_invitations.token_hash`, que F0 no toca.

### 3.6 Login y permisos (con cuentas reales, en el navegador)
| Cuenta | Acción | Esperado |
|---|---|---|
| MASTER_GLOBAL / ADMIN | iniciar sesión; abrir *Reuniones* y una reunión **finalizada** | carga sin errores; aparece «QR y asistencia» |
| ADMIN / OPERADOR / REUNIONES | abrir `…/reuniones/<id>/asistencia` | carga la consola (QR y panel) |
| LECTURA (si existe una cuenta real) | abrir la reunión y probar `…/asistencia` | **no** aparece «QR y asistencia»; `/asistencia` redirige a *sin permiso* |
| Cualquier cuenta | contraseña incorrecta ×1 | mensaje genérico «Email o contraseña incorrectos.» |
No se crean cuentas ni datos para esta prueba. Si no hay cuenta LECTURA real, queda cubierto por la suite (`f0-security.test.ts`, bloque S6).

### 3.7 Reuniones y QR
Con una cuenta con `meetings.accredit`, en el navegador: `…/api/reuniones/<id>/qr` de una reunión finalizada → `200` con un token (no copiarlo ni guardarlo) o `409` si la reunión no tiene fecha/hora. Hoy **no hay reuniones en curso ni programadas** (9 en borrador, 27 finalizadas), de modo que no hay ningún QR en uso que pueda romperse. Antes del primer evento real: probar de punta a punta con una reunión de prueba (QR → check-in) en una ventana controlada.

### 3.8 Integridad de la base
```bash
node /tmp/f0-readonly.cjs "$APP_DIR" /tmp/f0-pre.sql  > /tmp/f0-pre2.json   # (si no se guardó la salida del 1.7)
node -e '
const rd=f=>{const t=require("fs").readFileSync(f,"utf8");const o=[];let d=0,s=-1;for(let i=0;i<t.length;i++){if(t[i]==="{"){if(d===0)s=i;d++}else if(t[i]==="}"){d--;if(d===0)o.push(JSON.parse(t.slice(s,i+1)))}}return o};
const f=(file,p)=>Object.fromEntries(rd(file).find(x=>x.titulo.startsWith(p)).resultado.map(r=>[r.tabla,r.filas]));
const a=f("/tmp/f0-pre.json","P5"), b=f("/tmp/f0-post.json","Q5");
let n=0; for(const k of Object.keys(a)) if(a[k]!==b[k]){n++;console.log("CAMBIÓ",k,a[k],"→",b[k])}
console.log(n+" tabla(s) con diferencias (ver cuáles son esperables abajo)")'
```
(Ejecutar de nuevo `post.sql` justo antes para que Q5 sea del momento.) **Esperado:** cambian **solo** `permissions` (+1), `role_permissions` (+4), `public_link_attempts` (las pruebas de 3.3) y, por uso normal, `sessions`. **Deben quedar idénticas:** `people`, `people_associations`, `meeting_participations`, `meeting_invitations`, `meeting_attendance`, `meetings`, `person_interactions`, `organizations`, `associations`, `forms`, `form_submissions`, `users`, y todas las de Mailing.
**Si cambia cualquier otra:** DETENER y analizar (no revertir la base automáticamente).

### 3.9 Mailing sin envíos
`Q9` (post) vs `P3` (pre): **Esperado:** `campañas activas = 0`, `destinatarios en cola = 0`, `eventos de mailing` **igual** que en la línea de base, `worker con latido = 1`. `pm2 describe sutecba-mail`: **mismo** `uptime`/`pid` que en 1.6 (no se reinició). No se envió ningún correo desde la verificación.

### 3.10 Observación 24 horas
- `pm2 describe sutecba` (restarts), `pm2 logs sutecba --lines 500 --nostream | grep -iE "error|QrConfigError|Failed"`.
- Tasa de intentos bloqueados y escaneos: `SELECT scope, count(*), count(*) FILTER (WHERE succeeded) FROM public_link_attempts WHERE created_at > now() - interval '24 hours' GROUP BY 1;` (solo lectura).
- En el primer evento con QR real: observar que no haya «Demasiados intentos» para asistentes legítimos (topes: `checkin_qr` 1500/reunión y 400/IP cada 10 min).

### 3.11 Limpieza de temporales en el VPS
```bash
shred -u /tmp/f0-readonly.cjs /tmp/f0-pre.sql /tmp/f0-post.sql /tmp/f0-pre.json /tmp/f0-post.json /tmp/f0-pre2.json /tmp/f0-boot-check.ts /tmp/f0-remote-files.txt /tmp/f0-expected-files.txt 2>/dev/null || true
```
(La copia `.next.pre-f0-553ab60` se **conserva** al menos 7 días para poder volver sin recompilar.)

---

## Resumen de «DETENER»
| Situación | Qué hacer |
|---|---|
| Cualquier verificación previa (Parte 1) no coincide | No desplegar |
| `git pull` no es fast-forward | No forzar. Consultar |
| Chequeo de arranque (2.3) en BLOCKER | No migrar ni reiniciar |
| Migración falla (2.4) | No reintentar; ver rollback §3 |
| Esquema no coincide (2.5) | No compilar ni reiniciar |
| Build falla (2.6) | Restaurar `.next` (rollback §4) |
| `500`, `Failed to prepare server` o `QrConfigError` (2.8) | Rollback de código inmediato (§2) |
| IP falsa aparece en `public_link_attempts` o el límite no corta (3.3) | Rollback de código |
| Cambia una tabla que no debía (3.8) | Detenerse y analizar; no tocar la base |
