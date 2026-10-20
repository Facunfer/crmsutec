# F0 — Informe de cierre y auditoría final

**Fecha:** 2026-10-20 · **Base de producción:** `553ab60` (migraciones hasta la 0045) · **Cambios:** F0 sin commitear (nada en staging)
**Veredicto:** **GO para autorizar el commit** · **Despliegue: GO CONDICIONADO** al predeploy del runbook y a tu autorización expresa.
No se hizo commit ni push, no se desplegó, no se ejecutó ninguna migración productiva, no se reinició PM2, no se tocó nginx/firewall/variables/otras aplicaciones del VPS, no se enviaron correos.

---

## 1. Revisión de seguridad final (8 puntos) — contra el código real

Todas las comprobaciones se ejecutaron con las variables de F0 **sin definir** (como están hoy en el VPS). 24/24 PASS en la verificación del código, más pruebas de arranque con la build.

| # | Punto | Resultado | Evidencia |
|---|---|---|---|
| 1 | `SUTECBA_TRUSTED_PROXY_HOPS` por defecto = 1 | **PASS** | Sin variable → `1`; vacía → `1`; inválida (`x`, `9`, `-1`, `1.5`) → `1` (nunca «confiar en todo»); solo `0`–`5` explícitos cambian el valor (`lib/security/client-ip.ts`) |
| 2 | IP desde `X-Forwarded-For` sin confiar en valores del cliente | **PASS** | Se toma la entrada **de la derecha** (la que agrega nuestro nginx). Cliente que miente (`6.6.6.6`), que manda varias IP, que manda **dos líneas** del encabezado, `X-Real-IP` falso: siempre vale el peer. **200 pedidos rotando el encabezado = 1 sola identidad efectiva** |
| 3 | Compatible con nginx y `$proxy_add_x_forwarded_for` | **PASS** | La cadena se simuló como la arma nginx (`lo que mandó el cliente, IP-del-peer`); IPv6 se agrupa por /64; encabezado ausente → IP de reserva válida para `inet`. Coherente con lo que verificaste por SSH (un proxy, sin `real_ip`, app en `127.0.0.1:3100`) |
| 4 | `SUTECBA_QR_SECRET` validado al iniciar | **PASS, con un matiz de comportamiento** | Producción + secreto válido (43) → arranca; sin secreto, con 31 caracteres → falla; con 32 → arranca; `SUTECBA_QR_DISABLED=true` → arranca. **Matiz verificado con la build real (`next start`): ante un secreto ausente/corto el proceso NO termina: queda en pie (PM2 lo mostraría «online») pero TODAS las rutas responden 500** y el log trae `Failed to prepare server … QrConfigError`. Con secreto válido o QR deshabilitado, 303/401 normales. El mensaje nunca contiene el valor. Ver §6 (hallazgo O-1) |
| 5 | 0046 y 0047 son las únicas migraciones nuevas | **PASS** | `git ls-files --others` en `db/migrations` = exactamente esas dos; ninguna migración 0001–0045 modificada; numeración contigua (47 archivos) |
| 6 | La función de limpieza no se ejecuta desde roles no autorizados | **PASS** | `SECURITY DEFINER`, `search_path=public, pg_temp`, `EXECUTE` solo para el dueño y `sutecba_app`; `anon`, `authenticated`, `service_role` revocados (la 0046 los revoca y **se auto-verifica: aborta si queda otro grantee**). En producción (solo lectura): los privilegios por defecto darían `EXECUTE` a `postgres` y `service_role` (este último lo revoca la 0046), dueño de la tabla = rol que migra. Con el rol real `sutecba_app` sobre la copia restaurada: `anon`/`authenticated` → *permission denied* (27/27) |
| 7 | `meetings.accredit` respeta la matriz aprobada | **PASS** | Catálogo: ADMIN, MASTER_GLOBAL, OPERADOR, REUNIONES; **no** LECTURA (conserva `meetings.view`); aparece una sola vez, módulo `reuniones`. En la base (0047): las mismas cuatro asignaciones, y en ninguna otra. Rutas, página y funciones de librería lo exigen (52 pruebas en `f0-security.test.ts`) |
| 8 | Formularios públicos no agregan personas fuera de alcance | **PASS** | Valores válidos / de otra unidad / inactivos / UUID inexistente / texto manipulado: solo se suma a las de la unidad del formulario (o dependientes); un formulario ya publicado con una acción inválida tampoco se aplica en el servidor; **publicar** una configuración así se rechaza con error claro (sin ids; el nombre solo con alcance). En producción hoy: 0 formularios publicados y 0 acciones fuera de alcance |

**Verificación sobre lo que informaste del VPS.** Tomo como evidencia tuya (no la re-verifiqué: no tengo SSH): `proxy_pass http://127.0.0.1:3100`, `X-Forwarded-For $proxy_add_x_forwarded_for`, sin `real_ip`, escucha en `127.0.0.1:3100`, puerto 3100 no expuesto, puerto 3000 de otra aplicación, `.env` cargado por `@next/env` con `SUTECBA_ENV=production`, secreto de 43 caracteres, `QR_DISABLED` y `HOPS` sin definir. **Matiz sobre `@next/env`:** la prueba demuestra la carga en un proceso nuevo, no lo que ya tiene cargado el proceso vivo; no importa para F0 porque el reinicio recarga el `.env`, y el paso 2.3 del runbook repite exactamente esa carga (y aplica el mismo chequeo que hará el servidor) **antes** de migrar o reiniciar.

---

## 2. Auditoría del árbol de trabajo (Git)

`HEAD` = `553ab60` = `origin/master` (copia local) · rama `master` · **0 archivos en staging** · 38 modificados (37 de F0 + `package.json`, ajeno) · 27 sin trackear al iniciar este paso (19 de F0 + 8 que no van al commit); después se agregaron los dos runbooks y este informe.
Se verificó con `git status`, `git diff` y `git diff --check`. **No se usó `git add .` ni `git add -A`.**

### 2.1 Archivos del commit — lista exacta (59)

**Modificados (37)** — código y documentación de F0: `.env.example`, `SUTECBA_CONTEXTO.md`, `SUTECBA_SEGURIDAD.md`, `app/(protegido)/reuniones/[id]/asistencia/page.tsx`, `app/(protegido)/reuniones/[id]/page.tsx`, `app/api/reuniones/[id]/live/route.ts`, `app/api/reuniones/[id]/qr/route.ts`, `app/api/unsubscribe/[token]/route.ts`, `app/f/[slug]/FormRenderer.tsx`, `app/f/[slug]/actions.ts`, `app/f/[slug]/page.tsx`, `app/login/actions.ts`, `app/login/cambiar-contrasena/actions.ts`, `app/reunion/checkin/[qrToken]/route.ts`, `app/reunion/checkin/actions.ts`, `app/reunion/invitacion/[token]/actions.ts`, `app/reunion/invitacion/[token]/page.tsx`, `app/unsubscribe/[token]/page.tsx`, `lib/attendance/checkin.ts`, `lib/attendance/live.ts`, `lib/attendance/qr.ts`, `lib/attendance/session-tokens.ts`, `lib/db/env.ts`, `lib/forms/apply.ts`, `lib/forms/commands.ts`, `lib/forms/duplicates.ts`, `lib/forms/queries.ts`, `lib/forms/submissions.ts`, `lib/forms/submit.ts`, `lib/mailing/unsubscribe-limit.ts`, `lib/meetings/public.ts`, `lib/permissions/catalog.ts`, `lib/security/public-rate-limit.ts`, y los tests ajustados a propósito `tests/integration/forms.test.ts`, `tests/integration/mailing.test.ts`, `tests/integration/pglite-local.test.ts`, `tests/unit/permission-modules.test.ts`.

**Nuevos (22):**
- Migraciones (2): `db/migrations/0046_public_link_attempts_hardening.sql`, `db/migrations/0047_meetings_accredit_permission.sql`
- Código (5): `instrumentation.ts`, `lib/attendance/qr-config.ts`, `lib/security/client-ip.ts`, `lib/security/request-ip.ts`, `lib/security/text-safety.ts`
- Scripts de solo lectura / sobre copia descartable (2): `scripts/preflight-f0.ts`, `scripts/verify-f0-copy.ts`
- Tests (7): `tests/centinela/surface-behavior.test.ts`, `tests/integration/{f0-security,preflight-f0,public-endpoints-f0,verify-f0-copy}.test.ts`, `tests/unit/{client-ip,qr-config}.test.ts`
- Documentación (6): `docs/F0-SEGURIDAD-INFORME-Y-DESPLIEGUE.md`, `docs/F0-NGINX-PROPUESTA.md`, `docs/F0-PREFLIGHT-VPS-PROCEDIMIENTO.md`, `docs/F0-CIERRE-AUDITORIA-FINAL.md`, `docs/F0-RUNBOOK-DESPLIEGUE.md`, `docs/F0-RUNBOOK-ROLLBACK.md`

La lista exacta en orden alfabético está embebida en el runbook (paso 1.2) y se compara con `git diff --name-only` del remoto antes de desplegar.

### 2.2 Excluidos (ajenos a F0 o que no deben versionarse)
| Archivo | Motivo |
|---|---|
| `package.json` | Cambio de otra fase (script `audit:people-without-org`). F0 no agrega dependencias ni scripts |
| `scripts/audit-people-without-organization.ts` | Ajeno a F0 (auditoría de personas sin unidad) |
| `MIGRACIONES-ACTUALES-0001-0011.sql` | Volcado de trabajo previo, ajeno |
| `reporte-reconciliacion-sutecba.md` | Informe ajeno |
| `docs/ESTADO-DEL-SISTEMA-2026-10-19.md`, `docs/PLAN-MAESTRO-2026-10-19.md` | Documentos de otra etapa |
| `docs/F0-PREFLIGHT-2026-10-20.md`, `docs/F0-PREFLIGHT-EJECUCION-2026-10-20.md` | Registros de ejecución del preflight: contienen la IP del servidor y observaciones sobre otra aplicación del VPS. Se conservan **solo en local** |
| `.artifact-scratch/` | Carpeta de trabajo (logs, scripts de prueba, salidas). **No está en `.gitignore`**: nunca debe agregarse por comodín |
Ninguno de los excluidos es referenciado por un archivo del commit (verificado).

### 2.3 Contenido: secretos, credenciales, datos
Revisados los 58 archivos existentes (el 59.º es este informe): **sin coincidencias** con ningún valor del `.env` (se compararon sin imprimirlos), sin URLs de base, sin referencia al proyecto Supabase, sin claves (AWS/Resend/JWT/Svix/PEM/`postgres://user:pass@`), sin correos reales, sin DNI/teléfonos con forma real fuera de pruebas (los DNI de tests son sintéticos), sin respaldos ni volcados ni `.env`. Único hallazgo: la IP del servidor **ya figuraba en `SUTECBA_CONTEXTO.md` en `553ab60`**; F0 no la agrega. Dominio y puerto de la app aparecen en los runbooks (necesario para operar) pero ninguna IP.

### 2.4 ¿Altera módulos funcionales fuera del alcance? — **No**
- **Mailing:** el único archivo tocado es `lib/mailing/unsubscribe-limit.ts` (6 líneas): mismo identificador (sha256 del token), mismos umbrales (30 por enlace / 600 por IP cada 10 min); solo cambia de dónde sale la IP y el limitador pasa a ser atómico. **Nada** del envío, la cola, el worker, los proveedores SES/Resend, los webhooks ni la pantalla de Mailing cambió (`git diff` sobre `lib/mailing`, `app/api/mailing`, `app/(protegido)/mailing` y `scripts/mail-worker.ts`: solo ese archivo).
- **Personas, participaciones, semáforo, importaciones, usuarios, organizaciones:** sin cambios de código ni de datos (las migraciones no tocan esas tablas; verificado fila por fila en la restauración aislada).
- Los 4 tests existentes modificados fijaban el comportamiento corregido (tope por formulario, conteo de migraciones/permisos, «primer valor» del encabezado, matriz de permisos).

### 2.5 Resumen del diff
**37 archivos modificados: +437 / −152 líneas.** Nuevos: migraciones 157 líneas, código 204, scripts 375, tests 1.563, documentación ≈1.480 líneas (sin contar este informe).
Esta vuelta solo cambiaron **comentarios y textos** (aclaran que ante un secreto de QR inválido el sitio responde 500 con el proceso en pie): `lib/attendance/qr-config.ts`, `instrumentation.ts`, `.env.example`, `SUTECBA_CONTEXTO.md` y documentos. Sin cambio de comportamiento; igualmente se **volvió a ejecutar todo** (§3).

---

## 3. Pruebas finales (resultados exactos)

Se corrieron **dos veces**: en el árbol de trabajo y —el control definitivo— sobre **el contenido exacto del commit** (`553ab60` limpio + los 59 archivos, sin `.env`, sin los archivos ajenos).

| Verificación | Árbol de trabajo | **Árbol del commit** |
|---|---|---|
| Suite completa (Vitest) | 86 archivos pasan · 3 omitidos *(corrida previa a los ajustes de comentarios)* | **86 archivos pasan · 3 omitidos** *(con todos los cambios)* |
| Pruebas | 1260 pasan · 0 fallan · 25 omitidas | **1260 pasan · 0 fallan · 25 omitidas · EXIT 0** |
| Errores no controlados / advertencias en el log | sin errores (EXIT 0) | **0** |
| `npm run typecheck` | exit 0 | **exit 0** |
| `npm run build` (producción, `pipefail`) | exit 0 · `✓ Compiled successfully` · `instrumentation.js` generado | — |
| Arranque real de la build (`next start`) | secreto válido y QR deshabilitado: arranca (303/401); ausente/corto: 500 en todas las rutas (§1.4) | — |

**Las 25 omitidas** son 3 archivos de simulación con datos reales locales (`apply-nuevas` 15, `gabriel-real-simulation` 4, `nuevas-real-simulation` 6) que se saltean con `describe.skipIf(!enabled)` cuando no existen los archivos fuente; no pertenecen a F0 y no se ejecutan en CI.

**Pruebas específicas de F0 (todas verdes):** `f0-security` 52 · `public-endpoints-f0` 10 · `preflight-f0` 6 · `verify-f0-copy` 4 · `surface-behavior` (centinela) 19 · `client-ip` 11 · `qr-config` 8 · `permission-modules` 8 · `permissions-catalog` 11.

**Regresión por área (todas verdes):** formularios (`forms` 20, `forms-f1` 23, `forms-publish-dni` 11, `forms-field-types` 12) · asistencia/QR (`attendance` 10, `attendance-b3` 31, `attendance-qr` 7) · reuniones e invitaciones (`meetings` 11, `invitation-metadata` 33, `enrollments` 24, `meetings-state-machine` 7) · alcance y datos sensibles (`org-scope` 41, `sensitive-and-public` 25, `person-timeline` 19, `session-cleanup` 11) · migraciones y seed (`pglite-local` 5, `seed` 8, `mailing-migration-0045` 5).

**Mailing (Resend y SES) — mismo comportamiento que antes, sin correos reales:** `mailing` 41 (incluye SES, baja pública y rate limit de baja) · `mailing-resend` 13 · `resend-mailing` (unitarias) 24 · `mailing-sender-verify` 14 · `mailing-worker-shutdown` 4 · `mailing-migration-0045` 5. Todas usan proveedores simulados; **no se envió ningún correo**. Además, la suite completa de `553ab60` contra el esquema 0046/0047 dio 1139 pruebas verdes (rollback).

---

## 4. Commit propuesto (NO creado)

```
security: harden public forms, QR accreditation and rate limiting (F0)
```
Cuerpo sugerido: S1 identificadores de límite hasheados + saneamiento histórico (0046); S2 alcance de asociaciones en formularios (publicación y ejecución); S3 honeypot, tiempo mínimo y tope por persona; S4 IP del cliente solo desde proxies propios (`SUTECBA_TRUSTED_PROXY_HOPS`, default 1); S5 límite atómico en PostgreSQL con retención y función de limpieza restringida; S6 permiso `meetings.accredit` (0047); S7 `SUTECBA_QR_SECRET` obligatorio en producción con QR habilitado; S8 centinela de comportamiento; entradas con NUL/sustitutos sin error 500; scripts de preflight de solo lectura; runbooks.

Para crearlo (cuando autorices), con **lista explícita**:
```bash
git --literal-pathspecs add --pathspec-from-file=.artifact-scratch/f0-commit-files.txt   # exactamente los 59; los [corchetes] se toman literales; nunca git add . ni -A
git diff --cached --name-only | wc -l                      # esperado: 59
git status --short                                         # esperado: 59 en staging; los 7 ajenos y .artifact-scratch/ siguen sin tocar
git commit -m "security: harden public forms, QR accreditation and rate limiting (F0)"
```
(`--literal-pathspecs` evita que `[id]`, `[slug]`, `[token]` se interpreten como comodines. El comando se probó con `--dry-run`: agregaría exactamente los 59 archivos y ninguno de los excluidos.)

---

## 5. Entregables
| # | Entregable | Dónde |
|---|---|---|
| 1 | Informe de auditoría final | este documento |
| 2 | Lista exacta de archivos | §2.1 · `docs/F0-RUNBOOK-DESPLIEGUE.md` paso 1.2 |
| 3 | Resultados de tests, typecheck y build | §3 |
| 4 | Runbook de despliegue | `docs/F0-RUNBOOK-DESPLIEGUE.md` |
| 5 | Runbook de rollback | `docs/F0-RUNBOOK-ROLLBACK.md` |
| 6 | Riesgos residuales | §6 |
| 7 | Matriz GO / NO-GO | §7 |

---

## 6. Riesgos residuales y hallazgos

| ID | Sev. | Descripción | Estado / mitigación |
|---|---|---|---|
| **O-1** | Media (operativa, no de seguridad) | **Secreto de QR ausente/corto en producción ⇒ el sitio entero responde 500 mientras PM2 muestra `online`.** Antes de este paso se afirmaba «el servidor no inicia»; es inexacto y se corrigió en comentarios y documentos. Es fallar cerrado y visible en el log, pero con alcance mayor al QR | Mitigado: el secreto vigente tiene 43 caracteres; el runbook exige un **chequeo previo** (paso 2.3, reproduce la carga del `.env`) y una **verificación HTTP inmediata** con rollback (2.8). Alternativa opcional: que el hook termine el proceso (`process.exit(1)`) para que PM2 lo marque caído; implica reinicios en cascada. **No implementado: lo decidís vos** |
| R-2 | Media | Los topes del check-in (`checkin_qr` 1500/reunión y 400/IP, `identify`/`confirm` 300/400, 40 fallidos) son estimaciones; un evento de >1500 personas en 10 min o >400 desde un único Wi-Fi toparía | Observar «Demasiados intentos» en el primer evento; son constantes en `lib/attendance/checkin.ts` |
| R-3 | Media | Por ser PGlite, no se ejecutó la 0046 sobre PostgreSQL 17.6/Supabase reales: faltan los disparadores de evento (`pgrst_*`, `issue_*`), el pooler y el rol `postgres` no superusuario | Acotado leyendo el catálogo real (dueño, ACL por defecto) y por la **auto-verificación transaccional** de la 0046: si algo no cuadra, aborta sin dejar nada a medias |
| R-4 | Baja | Formularios públicos (S2/S3) **no se ejercitan en producción**: hay 0 publicados | Antes del primer formulario real: prueba de punta a punta con uno de prueba (se archiva después) |
| R-5 | Baja | El rollback devuelve temporalmente los defectos S4 y S6 (LECTURA puede pedir el QR; IP del primer valor) y hay una trampa: **no ejecutar `npm run seed` con el código viejo** (borraría las 4 asignaciones de `meetings.accredit`) | Documentado en el runbook de rollback §7 |
| R-6 | Baja | Hallazgos diferidos (aprobados): búsquedas de personas/asociaciones solo con sesión; login no atómico; rastro opcional de asociaciones rechazadas en la respuesta | Fuera de alcance de F0 |
| R-7 | Baja | `service_role` de Supabase tiene todos los privilegios sobre `public_link_attempts` (default de la plataforma, preexistente) | Solo quien tenga esa clave; no es de F0 |
| R-8 | Info | Sin CAPTCHA (por decisión): un botnet distribuido no se frena con topes por IP | Complemento posible: rate limit de nginx (`docs/F0-NGINX-PROPUESTA.md` §3.3) |
| R-9 | Info | Otra aplicación del VPS escucha en el 3000 expuesto a internet | Ajena a SUTECBA; no se toca |
| R-10 | Info | El `.env` del equipo de desarrollo apunta a **producción** con `SUTECBA_ENV=production`. Las pruebas lo neutralizan (`SUTECBA_ENV=test`, PGlite), pero un `migrate`/`seed` lanzado ahí sin esa protección iría contra producción | Las guardas exigen `--yes`; conviene un `.env` local de desarrollo |
| R-11 | Info | `sutecba-mail` sigue con su código anterior en memoria hasta su próximo reinicio | Compatible: Mailing no cambia; no hace falta reiniciarlo |

---

## 7. Matriz final GO / NO-GO

| Gate | Estado | Condición |
|---|---|---|
| Revisión de seguridad (8 puntos) | **GO** | 8/8 PASS; O-1 documentado y mitigado |
| Árbol de Git | **GO** | 59 archivos exactos; 7 ajenos fuera; sin secretos/datos |
| Pruebas (árbol del commit) | **GO** | 1260/0/25, typecheck y build limpios |
| Alcance funcional | **GO** | Mailing y módulos ajenos sin cambios |
| Migraciones | **GO** | Solo 0046/0047; ensayo aislado 64/64 y 27/27; auto-verificación |
| Rollback | **GO** | Código viejo compatible con el esquema nuevo; build anterior respaldado |
| Infraestructura (nginx, puerto, `.env`) | **GO** | Verificada por vos por SSH (ver §1) |
| **Autorizar el COMMIT** | **GO** | — |
| **Autorizar el DESPLIEGUE** | **GO condicionado** | Tras: tu autorización expresa del commit **y** del push; predeploy completo del runbook (respaldo verificado + restaurabilidad, copia de `.next`, PM2 y Mailing quietos, 0046/0047 aún no aplicadas, secreto ≥32 con el chequeo 2.3); ventana de bajo tráfico |

## 8. Recomendación final

**Estamos listos para que autorices el commit** (lista explícita de 59 archivos, pruebas verdes sobre el contenido exacto, sin secretos ni archivos ajenos). **El despliegue queda preparado** y es seguro de ejecutar siguiendo el runbook, **después** de que apruebes el push y se complete el predeploy; no lo recomiendo hasta tener el respaldo fresco verificado y la ventana acordada.
Una decisión tuya pendiente, no bloqueante: si querés que ante un secreto de QR inválido el proceso termine (visible para PM2) en lugar de responder 500 con el proceso en pie (§6 O-1). Mi recomendación es **dejarlo como está**: evita reinicios en cascada y queda cubierto por el chequeo previo y la verificación posterior.
