# F0 — Procedimiento operativo de preflight (VPS + ensayo aislado)

**Estado:** preparado, **no ejecutado contra producción**. Lo ejecuta el titular, en una sesión SSH autorizada, **un bloque por vez**, pegando
la salida de cada uno antes de pasar al siguiente. Nada de este procedimiento modifica nginx, PM2, la aplicación, la base de producción ni
el VPS: los comandos del VPS son de **solo lectura** (lo único que escriben son archivos temporales en `/tmp`, que se borran al final).

Qué se probó antes de entregarlo: el paquete de consultas (bloque C) se ejecutó sobre una base local migrada dentro de `BEGIN READ ONLY`
(11/11 válidas); el ejecutor se probó con un `pg` simulado (rechaza cualquier sentencia de escritura y nunca imprime la URL); los scripts
`scripts/preflight-f0.ts` y `scripts/verify-f0-copy.ts` tienen pruebas propias (`tests/integration/preflight-f0.test.ts`,
`tests/integration/verify-f0-copy.test.ts`).

| Bloque | Dónde | Escribe algo | Resultado |
|---|---|---|---|
| **0** Guarda | VPS | no | hostname correcto |
| **A** nginx, proxies, IP efectiva, puerto de Next.js | VPS | solo `/tmp` | PASS / BLOCKER |
| **B** `SUTECBA_QR_SECRET` | VPS | no | PASS / BLOCKER |
| **C** Base: formularios, privilegios, migraciones pendientes | VPS (lee la base) | solo `/tmp` | PASS / BLOCKER |
| **D** Ensayo 0046/0047 sobre una restauración aislada | **equipo con el árbol F0** (no el VPS) | solo carpetas temporales locales | PASS / BLOCKER |

> **Por qué D no es en el VPS:** las migraciones 0046/0047 y los scripts de verificación existen hoy solo en el árbol de trabajo de F0
> (sin commit, sin push). El VPS está en `553ab60` y no los tiene. Para D el único acceso a producción es el respaldo, que es de lectura.

**Resultado global:** F0 puede pasar a la autorización de despliegue solo si **A, B, C y D** dan PASS. Un solo BLOCKER detiene todo.

---

## Bloque 0 — Guarda (obligatorio, siempre primero)

```bash
export EXPECTED_HOST="<hostname-del-VPS-de-SUTECBA>"
export APP_DIR="<ruta-absoluta-de-la-app>"         # la carpeta que tiene .env y node_modules
export APP_NAME="<nombre-del-proceso-web-en-PM2>"
export APP_PORT="<puerto-local-de-Next>"           # el de proxy_pass
[ "$(hostname)" = "$EXPECTED_HOST" ] && echo "HOST OK: $(hostname)" || echo "HOST EQUIVOCADO ($(hostname)) → PARAR, no ejecutar nada más"
```
**Esperado:** `HOST OK`. **PASS:** coincide. **BLOCKER:** cualquier otra cosa (el VPS es compartido: no se sigue).

---

## Bloque A — nginx, cadena de proxies, IP efectiva y exposición del puerto de Next.js

**Objetivo:** confirmar que `SUTECBA_TRUSTED_PROXY_HOPS=1` (el valor por defecto) es correcto y que un cliente externo **no puede** manipular la IP
que usan los límites. La app toma la **última** entrada de `X-Forwarded-For` (la que agrega nuestro nginx). Eso solo es seguro si (1) hay un
único proxy propio delante, sin CDN, y (2) **todo** el tráfico pasa por nginx (si la app es alcanzable directo, el cliente escribe todo el encabezado).

### A1 — Volcar la configuración efectiva de nginx (solo lectura)
```bash
nginx -v 2>&1
sudo nginx -T > /tmp/f0-nginx-full.txt 2> /tmp/f0-nginx-test.txt ; tail -2 /tmp/f0-nginx-test.txt
```
`nginx -T` prueba y vuelca la configuración; no recarga ni cambia nada. **Esperado:** `syntax is ok` y `test is successful`.

### A2 — Ver SOLO los bloques `server` de SUTECBA
```bash
awk '
  /^[[:space:]]*server[[:space:]]*\{/ { blk=""; inb=1; depth=0 }
  inb { blk = blk $0 "\n"; l=$0; o=gsub(/\{/,"&",l); l=$0; c=gsub(/\}/,"&",l); depth += o - c;
        if (depth <= 0) { if (blk ~ /server_name[^;]*(crm\.sutecba|sutecba\.duckdns)/) printf "%s\n=========\n", blk; inb=0 } }
' /tmp/f0-nginx-full.txt
grep -n -A4 -E "^[[:space:]]*upstream[[:space:]]" /tmp/f0-nginx-full.txt | head -40
```
Revisá el texto antes de pegarlo (puede incluir rutas de certificados; no contiene claves). **Esperado, en el `location` que hace `proxy_pass` a la app:**
- `proxy_pass http://127.0.0.1:<APP_PORT>` (o un `upstream` que apunte a 127.0.0.1) — **no** a una IP pública.
- `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` **o** `proxy_set_header X-Forwarded-For $remote_addr;`.
- `listen 80` / `listen 443 ssl`, sin otros puertos que lleguen a la app.

### A3 — ¿Reescribe la IP algún módulo global? (CDN / real_ip)
```bash
grep -n -E "set_real_ip_from|real_ip_header|real_ip_recursive|ignore_invalid_headers|underscores_in_headers" /tmp/f0-nginx-full.txt
```
**Esperado:** sin coincidencias (o solo líneas comentadas). Si aparece `set_real_ip_from`, hay un proxy/CDN delante: ver el criterio abajo.

### A4 — ¿Hay un CDN delante? (el DNS debe apuntar a ESTE servidor)
```bash
for h in crm.sutecba.com sutecba.duckdns.org; do echo "$h → $(getent ahostsv4 $h | awk '{print $1}' | sort -u | tr '\n' ' ')"; done
echo "IP pública de este servidor → $(curl -s4 -m 8 https://ifconfig.me)"
```
**Esperado:** las IP de ambos nombres **coinciden** con la IP pública del servidor.

### A5 — ¿Dónde escucha Next.js?
```bash
sudo ss -ltnp | grep -E "node|next|:${APP_PORT}\b"
```
**Esperado:** `127.0.0.1:<APP_PORT>` (solo loopback). **Alerta:** `0.0.0.0:<APP_PORT>`, `*:<APP_PORT>` o `[::]:<APP_PORT>` (escucha en todas las interfaces → verificar A6 y A7).

### A6 — Firewall (solo lectura)
```bash
sudo ufw status verbose 2>/dev/null | head -25
sudo iptables -S INPUT 2>/dev/null | head -30
sudo nft list ruleset 2>/dev/null | head -50
```
**Esperado:** el puerto de la app **no** figura como permitido desde afuera (solo 22/80/443). Si la app corre en Docker con puerto publicado, ufw **no** lo filtra: ver A7.

### A7 — Prueba desde AFUERA (desde otra máquina, no el VPS)
```bash
curl -sS -m 8 -o /dev/null -w "HTTP %{http_code}\n" "http://<IP-pública-del-VPS>:<APP_PORT>/login" ; echo "exit=$?"
curl -sS -m 8 -I https://crm.sutecba.com/login | head -3
```
**Esperado:** la primera **falla** (timeout / `Connection refused`, `exit` distinto de 0, sin `HTTP 200`); la segunda responde normalmente (el sitio sigue accesible por nginx).

### A8 — ¿Algún otro `server` o puerto llega a la misma app?
```bash
grep -n "proxy_pass" /tmp/f0-nginx-full.txt
```
**Esperado:** solo los bloques de SUTECBA apuntan a `127.0.0.1:<APP_PORT>`; los demás proxies de la máquina apuntan a otros puertos.

### Criterios del bloque A
| Resultado | Condición | Acción |
|---|---|---|
| **PASS** | `X-Forwarded-For` es `$proxy_add_x_forwarded_for` o `$remote_addr`; un solo nginx; A3 sin `real_ip`; A4 las IP coinciden; A5 solo loopback **o** A7 confirma que no es alcanzable desde afuera | `SUTECBA_TRUSTED_PROXY_HOPS=1` (no hace falta definirlo) |
| **BLOCKER** | A7 responde `HTTP 200` (la app es alcanzable sin nginx) | Cerrar el puerto en el firewall o bindear a `127.0.0.1` **antes** de desplegar |
| **BLOCKER** | A4 muestra IP distintas (CDN/otro proxy) o A3 tiene `real_ip` | Definir `SUTECBA_TRUSTED_PROXY_HOPS=2` y `real_ip` según `docs/F0-NGINX-PROPUESTA.md` §3.2, y volver a verificar |
| **BLOCKER** | `X-Forwarded-For` tiene otro valor (p. ej. `$http_x_forwarded_for` a secas) o hay varios `server` con distinto manejo | Corregir con el titular de nginx (propuesta §3.1) |
| **WARNING** | A5 muestra `0.0.0.0` pero A6/A7 confirman bloqueo | Aceptable; conviene bindear a `127.0.0.1` |

```bash
rm -f /tmp/f0-nginx-full.txt /tmp/f0-nginx-test.txt     # al terminar el bloque
```

---

## Bloque B — `SUTECBA_QR_SECRET` (existencia y longitud, sin imprimir el contenido)

**Objetivo:** con F0, en producción, si el secreto falta o mide menos de 32 caracteres el sitio **queda fuera de servicio: el proceso sigue «online» en PM2 pero TODAS las rutas responden 500** (comportamiento verificado con la build; el error queda en el log). No se cambia ni se rota el existente.
Next.js carga `.env.production.local`, `.env.local`, `.env.production` y `.env` (en ese orden de prioridad) y el entorno del proceso gana sobre todos.
Los comandos imprimen **solo** presencia, largo y una huella de 6 caracteres (para detectar fuentes con valores distintos); jamás el valor.

### B1 — Archivos de entorno de la app
```bash
cd "$APP_DIR"
for f in .env.production.local .env.local .env.production .env; do
  [ -f "$f" ] && node -e '
    const t=require("fs").readFileSync(process.argv[1],"utf8");
    const g=k=>{const m=t.match(new RegExp("^\\s*(?:export\\s+)?"+k+"\\s*=\\s*(.*)$","m"));return m?m[1].trim().replace(/^["\x27]|["\x27]$/g,""):null};
    const q=g("SUTECBA_QR_SECRET");
    const h=q?require("crypto").createHash("sha256").update(q).digest("hex").slice(0,6):"-";
    console.log(process.argv[1].padEnd(22),"QR:",q===null?"no definido":"definido, largo "+q.length+(q.length>=32?" OK":" CORTO"),"huella",h,"| SUTECBA_ENV="+g("SUTECBA_ENV"),"| QR_DISABLED="+g("SUTECBA_QR_DISABLED"),"| HOPS="+g("SUTECBA_TRUSTED_PROXY_HOPS"));
  ' "$f"
done
```

### B2 — Entorno inicial del proceso y PM2 (sin volcar variables)
```bash
PID=$(pm2 pid "$APP_NAME" 2>/dev/null | head -1); echo "pid=$PID"
sudo tr '\0' '\n' < /proc/$PID/environ | awk -F= '
  $1=="SUTECBA_QR_SECRET"{v=substr($0,index($0,"=")+1); printf "proceso: QR definido, largo %d\n", length(v)}
  $1=="SUTECBA_ENV"{print "proceso: SUTECBA_ENV=" $2}
  $1=="SUTECBA_QR_DISABLED"{print "proceso: QR_DISABLED=" $2}
  $1=="SUTECBA_TRUSTED_PROXY_HOPS"{print "proceso: HOPS=" $2}'
ls "$APP_DIR"/ecosystem.config.* 2>/dev/null && grep -c "SUTECBA_QR_SECRET" "$APP_DIR"/ecosystem.config.* 2>/dev/null
```
**Nunca** uses `pm2 env`, `pm2 show` ni `cat .env`: imprimen secretos. `/proc/<pid>/environ` solo muestra el entorno **inicial** del proceso; lo que Next lee de los `.env` aparece en B1.

### Criterios del bloque B
| Resultado | Condición |
|---|---|
| **PASS** | El valor **efectivo** (proceso > `.env.production.local` > `.env.local` > `.env.production` > `.env`) está definido, **largo ≥ 32**, y las huellas de todas las fuentes que lo definen **coinciden**; `SUTECBA_ENV=production` llega al proceso (en B1 o B2) |
| **PASS (alternativa)** | `QR_DISABLED=true` **y** se confirma por escrito que esta instalación no usa QR (no es el caso hoy: hay acreditación por QR) |
| **BLOCKER** | No definido, `CORTO`, o fuentes con huellas distintas (no se sabe cuál usa la app) → **no desplegar**: el sitio respondería 500 en todas las rutas. Resolverlo sin imprimir ni rotar el secreto vigente |
| **WARNING** | `SUTECBA_ENV` no llega como `production` al proceso: el chequeo de arranque no se activaría (el uso sigue fallando cerrado). Corregir antes de depender de él |

---

## Bloque C — Base: formularios fuera de alcance, privilegios, migraciones pendientes (solo lectura)

**Objetivo:** responder, con la base real y sin escribir nada, lo que decide el despliegue: (1) ¿algún formulario publicado cambiaría de comportamiento?,
(2) ¿la migración 0046 va a poder verificar sus propios permisos (dueño de la tabla, privilegios por defecto de Supabase)?, (3) ¿cuántas filas toca?,
(4) ¿las IP que registra la app hoy son reales (evidencia histórica del encabezado)?

El ejecutor abre **una transacción `READ ONLY`**, rechaza cualquier sentencia que no sea de lectura y **no imprime la URL de la base**. La salida contiene
cantidades, ids internos, slugs públicos y nombres de roles: **ningún dato personal**.

### C1 — Crear el ejecutor y el paquete en `/tmp` (no en la app)
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

cat > /tmp/f0-readonly-pack.sql <<'F0PACK'
-- C1 · identidad de la conexión (debe ser la base de PRODUCCIÓN y el rol que migra)
SELECT current_database() AS base, current_user AS rol, split_part(version(), ' on ', 1) AS version
-- @@
-- C2 · últimas migraciones aplicadas (la última debe ser 0045_mailing_provider_resend.sql)
SELECT filename FROM sutecba_migrations ORDER BY filename DESC LIMIT 3
-- @@
-- C3 · formularios PUBLICADOS con acciones de asociación fuera de alcance (esperado: 0 filas)
WITH snap AS (
    SELECT f.id AS form_id, f.slug, f.status, f.published_version, f.owner_organization_id,
           act->>'actionType' AS action_type, act->'config'->>'associationId' AS assoc_text
    FROM forms f JOIN form_versions fv ON fv.form_id = f.id AND fv.version = f.published_version
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(fv.schema->'actions', '[]'::jsonb)) AS act
    WHERE f.published_version IS NOT NULL)
  SELECT form_id::text, slug, status, published_version, CASE
  WHEN assoc_text IS NULL OR assoc_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN 'id ausente o mal formado'
  WHEN NOT EXISTS (SELECT 1 FROM associations a WHERE a.id::text = assoc_text) THEN 'asociación inexistente'
  WHEN EXISTS (SELECT 1 FROM associations a WHERE a.id::text = assoc_text AND a.status <> 'active') THEN 'asociación inactiva'
  ELSE 'asociación de otra unidad' END AS motivo
  FROM snap s
  WHERE s.action_type = 'add_to_association'
    AND NOT EXISTS (SELECT 1 FROM associations a WHERE a.id::text = s.assoc_text AND a.status = 'active'
      AND a.owner_organization_id IN (SELECT organization_id FROM organization_descendants(s.owner_organization_id)))
  ORDER BY slug
-- @@
-- C4 · acciones CONFIGURADAS fuera de alcance (esperado: 0 filas; si hay, la próxima publicación se rechazará)
WITH cfg AS (
    SELECT fa.id AS action_id, f.id AS form_id, f.slug, f.status, f.owner_organization_id, fa.config->>'associationId' AS assoc_text
    FROM form_actions fa JOIN forms f ON f.id = fa.form_id WHERE fa.action_type = 'add_to_association')
  SELECT action_id::text, form_id::text, slug, status, CASE
  WHEN assoc_text IS NULL OR assoc_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN 'id ausente o mal formado'
  WHEN NOT EXISTS (SELECT 1 FROM associations a WHERE a.id::text = assoc_text) THEN 'asociación inexistente'
  WHEN EXISTS (SELECT 1 FROM associations a WHERE a.id::text = assoc_text AND a.status <> 'active') THEN 'asociación inactiva'
  ELSE 'asociación de otra unidad' END AS motivo
  FROM cfg c
  WHERE NOT EXISTS (SELECT 1 FROM associations a WHERE a.id::text = c.assoc_text AND a.status = 'active'
    AND a.owner_organization_id IN (SELECT organization_id FROM organization_descendants(c.owner_organization_id)))
  ORDER BY slug
-- @@
-- C5 · contexto de formularios
SELECT count(*) FILTER (WHERE status = 'published')::int AS publicados, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM form_actions fa WHERE fa.form_id = forms.id AND fa.action_type = 'add_to_association'))::int AS con_accion_de_asociacion FROM forms
-- @@
-- C6 · dueño de la tabla de intentos vs. rol que migra (deben coincidir) y privilegios actuales de sutecba_app (DELETE debe ser false)
SELECT pg_get_userbyid(c.relowner) AS dueno_tabla, current_user AS rol_que_migra, has_table_privilege('sutecba_app', 'public.public_link_attempts', 'DELETE') AS sutecba_app_puede_borrar, c.relrowsecurity AS rls_activa FROM pg_class c WHERE c.oid = 'public.public_link_attempts'::regclass
-- @@
-- C7 · roles presentes (deben existir sutecba_app; los otros 3 los revoca la 0046 si existen)
SELECT rolname FROM pg_roles WHERE rolname IN ('sutecba_app', 'anon', 'authenticated', 'service_role') ORDER BY 1
-- @@
-- C8 · quién recibiría EXECUTE por defecto en funciones nuevas del rol que migra (permitidos: PUBLIC, anon, authenticated, service_role, sutecba_app y el propio rol; cualquier otro = BLOCKER)
SELECT DISTINCT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee
FROM pg_default_acl d, aclexplode(d.defaclacl) a
WHERE d.defaclobjtype = 'f' AND d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)
  AND d.defaclnamespace IN (0, 'public'::regnamespace) AND a.privilege_type = 'EXECUTE' ORDER BY 1
-- @@
-- C9 · tamaño de public_link_attempts y filas que la 0046 va a sanear / que la limpieza alcanzaría
SELECT (SELECT count(*) FROM public_link_attempts)::int AS filas,
  (SELECT count(*) FROM public_link_attempts WHERE scope IN ('invitation_view', 'invitation_respond', 'invitation_checkin', 'checkin_qr') AND identifier NOT LIKE 'h1:%')::int AS a_sanear,
  (SELECT count(*) FROM public_link_attempts WHERE created_at < now() - interval '30 days')::int AS mas_viejas_que_30_dias
-- @@
-- C10 · permisos/roles de la 0047 (meetings_accredit_ya_existe debe ser false; los 4 roles deben existir)
SELECT (SELECT count(*) FROM permissions WHERE key = 'meetings.accredit')::int > 0 AS meetings_accredit_ya_existe, (SELECT string_agg(key, ', ' ORDER BY key) FROM roles WHERE key IN ('MASTER_GLOBAL', 'ADMIN', 'OPERADOR', 'REUNIONES')) AS roles_destino
-- @@
-- C11 · clases de IP registradas HASTA HOY por el código actual (toma el primer valor de X-Forwarded-For). Esperado: publicas > 0 y ips_distintas alta; loopback = 0
SELECT 'login_attempts' AS origen, count(*)::int AS filas, count(DISTINCT ip_address)::int AS ips_distintas,
  count(*) FILTER (WHERE ip_address <<= inet '127.0.0.0/8' OR ip_address = inet '::1')::int AS loopback,
  count(*) FILTER (WHERE ip_address <<= inet '10.0.0.0/8' OR ip_address <<= inet '172.16.0.0/12' OR ip_address <<= inet '192.168.0.0/16' OR ip_address <<= inet 'fc00::/7')::int AS privadas,
  count(*) FILTER (WHERE NOT (ip_address <<= inet '127.0.0.0/8' OR ip_address = inet '::1' OR ip_address <<= inet '10.0.0.0/8' OR ip_address <<= inet '172.16.0.0/12'
    OR ip_address <<= inet '192.168.0.0/16' OR ip_address <<= inet 'fc00::/7'))::int AS publicas
FROM login_attempts
UNION ALL
SELECT 'form_submissions' AS origen, count(*)::int AS filas, count(DISTINCT ip_address)::int AS ips_distintas,
  count(*) FILTER (WHERE ip_address <<= inet '127.0.0.0/8' OR ip_address = inet '::1')::int AS loopback,
  count(*) FILTER (WHERE ip_address <<= inet '10.0.0.0/8' OR ip_address <<= inet '172.16.0.0/12' OR ip_address <<= inet '192.168.0.0/16' OR ip_address <<= inet 'fc00::/7')::int AS privadas,
  count(*) FILTER (WHERE NOT (ip_address <<= inet '127.0.0.0/8' OR ip_address = inet '::1' OR ip_address <<= inet '10.0.0.0/8' OR ip_address <<= inet '172.16.0.0/12'
    OR ip_address <<= inet '192.168.0.0/16' OR ip_address <<= inet 'fc00::/7'))::int AS publicas
FROM form_submissions
UNION ALL
SELECT 'public_link_attempts' AS origen, count(*)::int AS filas, count(DISTINCT ip_address)::int AS ips_distintas,
  count(*) FILTER (WHERE ip_address <<= inet '127.0.0.0/8' OR ip_address = inet '::1')::int AS loopback,
  count(*) FILTER (WHERE ip_address <<= inet '10.0.0.0/8' OR ip_address <<= inet '172.16.0.0/12' OR ip_address <<= inet '192.168.0.0/16' OR ip_address <<= inet 'fc00::/7')::int AS privadas,
  count(*) FILTER (WHERE NOT (ip_address <<= inet '127.0.0.0/8' OR ip_address = inet '::1' OR ip_address <<= inet '10.0.0.0/8' OR ip_address <<= inet '172.16.0.0/12'
    OR ip_address <<= inet '192.168.0.0/16' OR ip_address <<= inet 'fc00::/7'))::int AS publicas
FROM public_link_attempts
F0PACK
```

### C2 — Ejecutar
```bash
node /tmp/f0-readonly.cjs "$APP_DIR" /tmp/f0-readonly-pack.sql | tee /tmp/f0-preflight-out.json
```
Usa el `pg` y la URL de migración (`SUTECBA_MIGRATION_DATABASE_URL`) que ya tiene la app. Pegame la salida completa.

### Qué esperar y cómo decidir
| Consulta | Esperado | PASS | BLOCKER / WARNING |
|---|---|---|---|
| **C1** identidad | `base` = la de producción; `rol` = el que migra (`postgres`) | coincide | **BLOCKER** si la base o el rol no son los esperados |
| **C2** migraciones | la última es `0045_mailing_provider_resend.sql` | sí | **BLOCKER** si hay otras posteriores o faltan anteriores |
| **C3** publicados fuera de alcance | **0 filas** | 0 filas | **BLOCKER** si hay filas: esas acciones **dejarán de sumar personas** tras el despliegue (el envío se procesa igual). Decidir qué hacer con cada `slug` (reasignar la asociación o la unidad del formulario) **antes** |
| **C4** configuradas fuera de alcance | **0 filas** | 0 filas | **WARNING** si hay filas solo acá: la próxima publicación de ese formulario será **rechazada** con un error claro hasta corregirlas |
| **C5** contexto | informativo | — | — |
| **C6** dueño de la tabla | `dueno_tabla` = `rol_que_migra`; `sutecba_app_puede_borrar` = `false`; `rls_activa` = `true` | sí | **BLOCKER** si el dueño es otro rol que además no puede borrar: la verificación interna de la 0046 abortaría la migración (no queda nada a medias) |
| **C7** roles | aparece `sutecba_app` (y, en Supabase, `anon`, `authenticated`, `service_role`) | sí | **BLOCKER** si falta `sutecba_app` |
| **C8** EXECUTE por defecto | solo entre: `PUBLIC`, `anon`, `authenticated`, `service_role`, `sutecba_app` y el propio rol | sí | **BLOCKER** si aparece **cualquier otro** rol: la 0046 no lo revoca y su verificación abortaría. Pasarme el nombre |
| **C9** tamaño | `filas` < 1.000.000 | sí | **WARNING** si es mayor: migrar en una ventana tranquila (el saneamiento y el índice toman un lock) |
| **C10** 0047 | `meetings_accredit_ya_existe` = `false`; `roles_destino` lista los 4 roles | sí | **WARNING** si ya existe (la 0047 es idempotente) o falta un rol |
| **C11** IP históricas | `publicas` > 0, `ips_distintas` alta, `loopback` ≈ 0 | sí | **BLOCKER** si casi todo es `loopback`: nginx no estaría reenviando la IP y los límites por IP serían un solo cubo. **WARNING** si predominan `privadas`: revisar si hay otro proxy interno |

> **Alternativa equivalente** (desde el equipo con el árbol F0 y su `.env`): `npx tsx scripts/preflight-f0.ts` ejecuta las mismas comprobaciones, además
> decide solo (`ok`, `blockers`, `warnings`) y sale con código 2 si hay bloqueos. Es de solo lectura por el mismo mecanismo.

```bash
shred -u /tmp/f0-readonly.cjs /tmp/f0-readonly-pack.sql /tmp/f0-preflight-out.json 2>/dev/null || rm -f /tmp/f0-readonly.cjs /tmp/f0-readonly-pack.sql /tmp/f0-preflight-out.json
```

---

## Bloque D — Ensayo de 0046 y 0047 sobre una restauración aislada de producción

**Objetivo:** aplicar las migraciones sobre una **copia** restaurada de producción y verificar, con el rol real `sutecba_app`, permisos, funciones y datos.
**Nunca se usa la base productiva como destino:** el respaldo es de solo lectura; la restauración y las migraciones ocurren en una base PGlite temporal local
(`restore-logical-backup.ts` fuerza `SUTECBA_ENV=test` y un directorio temporal; `verify-f0-copy.ts` borra las URLs de Postgres del entorno antes de abrir nada).

**Dónde:** en el equipo que tiene el **árbol de trabajo de F0** (no en el VPS). No ejecutar `npm run migrate` ni `npm run seed` en ningún paso.
Los datos del respaldo son **personales**: carpeta fuera del repositorio, permisos restringidos, y se borra al terminar.

### D1 — Respaldo lógico (solo lectura sobre producción)
```bash
npm run backup:logical -- --out-dir "<carpeta privada FUERA del repo>" --label pre-f0
```
**Esperado:** exit 0, una carpeta con `MANIFEST.json` (filas y SHA-256 por tabla, lista de migraciones aplicadas). **Anotá** `tablas.public_link_attempts.filas`.
**BLOCKER:** error de conexión o de verificación del respaldo.

### D2 — Restaurar en una base aislada y aplicar 0046/0047 encima
```bash
npx tsx scripts/restore-logical-backup.ts --backup "<carpeta del D1>" --keep
```
**Esperado en el informe JSON que imprime:**
- `archivos_vs_manifest`: `"OK (hash y filas de las tablas)"`
- `tablas_no_restauradas`: `[]`
- `tablas_identicas_fila_por_fila`: `"N de N"` (todas)
- `migraciones_aplicadas_sobre_la_copia`: **exactamente** `["0046_public_link_attempts_hardening.sql", "0047_meetings_accredit_permission.sql"]`
- `conteos_criticos`: `respaldo` = `despues_de_migrar` en cada tabla (las migraciones no cambian cantidades de personas, participaciones, etc.)

**BLOCKER:** cualquier diferencia, tabla sin restaurar, o un error de migración (un mensaje que empiece con `0046:` es la verificación interna de permisos y
dice qué rol o qué dueño está mal).

### D3 — Verificar con el rol real `sutecba_app`
Ubicá la carpeta que dejó `--keep` (`<temp>/sutecba-restore-XXXX/pglite`) y ejecutá:
```bash
# PowerShell: Get-ChildItem $env:TEMP -Directory -Filter 'sutecba-restore-*' | Sort-Object LastWriteTime -Descending | Select-Object -First 1 | ForEach-Object { Join-Path $_.FullName 'pglite' }
npx tsx scripts/verify-f0-copy.ts --data-dir "<carpeta pglite>" --backup "<carpeta del D1>"
```
Hace ~26 comprobaciones dentro de **una transacción que siempre se revierte** (la copia queda intacta): función `SECURITY DEFINER` con `search_path` fijo y mismo dueño que la
tabla; `EXECUTE` solo para el dueño y `sutecba_app` (y `anon`/`authenticated`/`service_role` sin acceso); `UPDATE` solo sobre `succeeded`; **como `sutecba_app`**:
`DELETE`, `TRUNCATE` y `UPDATE identifier/created_at` rechazados, `INSERT`/`SELECT`/`UPDATE succeeded` permitidos, la limpieza funciona aunque no tenga `DELETE`, rechaza retención 0 y
`anon`/`authenticated` no pueden invocarla; 0 tokens sin sanear; **mismo total de filas** que el respaldo; `meetings.accredit` en los 4 roles y en ningún otro.

**Esperado:** `RESUMEN: N/N PASS, 0 FAIL → PASS` y exit 0. **BLOCKER:** cualquier `FAIL` (exit 2).

### D4 — Limpieza (los datos son personales)
```bash
# borrar la carpeta del respaldo (D1) y la carpeta temporal sutecba-restore-XXXX (D2)
```

### Qué cubre y qué NO cubre el bloque D
- **Cubre:** la lógica real de 0046/0047 sobre los datos reales de producción (saneamiento fila por fila, conteos intactos, tiempos), y los privilegios con el rol `sutecba_app` realmente aplicados.
- **No reproduce** (PGlite es un único superusuario): los **privilegios por defecto de Supabase** ni el **dueño real** de los objetos. Eso lo cubren **C6 y C8** (leen el catálogo real de producción en solo lectura)
  y la **verificación interna de la 0046**, que aborta la migración (transaccional) si el dueño o los grantees no son los previstos.

### D-2 (opcional, mayor fidelidad): PostgreSQL real aislado
Solo si se dispone de binarios de PostgreSQL 17 (mismo mayor que Supabase) en una máquina **que no sea la de producción**. Sin red: solo socket Unix.
```bash
PGBIN=<carpeta bin de PostgreSQL 17>; D=/tmp/f0-scratch-pg
$PGBIN/initdb -D $D -A trust -U postgres
$PGBIN/pg_ctl -D $D -o "-c listen_addresses='' -c unix_socket_directories=/tmp -c port=55432" -l /tmp/f0-pg.log start
export PGHOST=/tmp PGPORT=55432 PGUSER=postgres
psql -v ON_ERROR_STOP=1 -c "create role sutecba_app nologin; create role anon nologin; create role authenticated nologin; create role service_role nologin;"
psql -c "alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;"   # imita a Supabase
createdb f0 && pg_restore --no-owner -d f0 "<full-public.dump de backup-pgdump.cjs>"
psql -d f0 -v ON_ERROR_STOP=1 -f db/migrations/0046_public_link_attempts_hardening.sql -f db/migrations/0047_meetings_accredit_permission.sql
```
Luego las mismas verificaciones, cada una en su propia transacción:
```sql
SELECT r, has_function_privilege(r,'public.purge_public_link_attempts(integer)','EXECUTE') FROM unnest(ARRAY['sutecba_app','anon','authenticated','service_role']) r;  -- solo sutecba_app = true
BEGIN; SET LOCAL ROLE sutecba_app; DELETE FROM public_link_attempts WHERE false; ROLLBACK;          -- debe fallar: permission denied
BEGIN; SET LOCAL ROLE sutecba_app; UPDATE public_link_attempts SET succeeded = succeeded WHERE false; ROLLBACK;   -- debe pasar
BEGIN; SET LOCAL ROLE sutecba_app; SELECT public.purge_public_link_attempts(30); ROLLBACK;           -- debe pasar
BEGIN; SET LOCAL ROLE anon;        SELECT public.purge_public_link_attempts(1);  ROLLBACK;          -- debe fallar: permission denied
```
**PASS:** coincide con lo esperado y las migraciones terminaron sin error. **BLOCKER:** cualquier desvío. Al terminar: `pg_ctl -D $D stop; rm -rf $D`.

---

## Resumen de decisión

| Bloque | PASS exige | Si falla |
|---|---|---|
| 0 | hostname correcto | no se sigue |
| A | 1 proxy propio, XFF correcto, sin CDN, puerto de Next no alcanzable | corregir infraestructura y repetir A (no se despliega) |
| B | secreto efectivo ≥ 32, fuentes coherentes, `SUTECBA_ENV=production` | no se despliega (el sitio respondería 500 en todas las rutas) |
| C | C3 = 0 filas; C6/C8 sin bloqueos; C11 con IP reales | decidir caso por caso y repetir C |
| D | D2 sin diferencias; D3 todo PASS | corregir y repetir D |

Con **A, B, C y D en PASS**, se presenta el resultado y se solicita la autorización expresa de despliegue (`docs/F0-SEGURIDAD-INFORME-Y-DESPLIEGUE.md` §8). Sin esa autorización no se ejecuta nada en producción.
