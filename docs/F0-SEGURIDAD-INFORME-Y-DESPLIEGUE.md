# Fase F0 — Endurecimiento de seguridad: informe, despliegue y reversión

**Estado:** implementado y probado **en local**. Sin commit, sin push, sin despliegue, sin migraciones contra producción, sin cambios en
nginx/PM2/VPS. **Producción: NO-GO** hasta cerrar el preflight de infraestructura (`docs/F0-PREFLIGHT-VPS-PROCEDIMIENTO.md`). Se espera autorización antes de cualquier cambio en producción.

Base: `master` @ `553ab60`. Migraciones nuevas: **0046** y **0047** (la última real del repositorio era la 0045).

**Actualización 2026-10-20 (después del preflight):** se agregaron tres correcciones autorizadas —(1) permisos de la función de limpieza endurecidos y
verificados dentro de la propia migración 0046, (2) validación de asociaciones **al publicar** formularios, (3) caracteres que la base no puede guardar
(byte nulo, sustitutos sueltos) en entradas públicas: validación en lugar de error 500— más el procedimiento operativo de preflight y dos scripts de solo
lectura con pruebas. Ver §1-bis.

---

## 1. Hallazgos: confirmados y corregidos

Los ocho existían tal como los describía el plan; se verificó cada uno contra el código.

| # | Hallazgo | Confirmación | Corrección |
|---|---|---|---|
| **S1** | Token de invitación en claro como identificador del límite | `lib/meetings/public.ts` pasaba `token` a `public_link_attempts.identifier` en `invitation_view/respond/checkin`; `lib/attendance/checkin.ts` guardaba además los primeros 24 caracteres del token de QR | Identificador = `h1:` + sha256 con separación de dominio (`hashRateLimitIdentifier`). Migración 0046 sanea lo histórico con la **misma fórmula** (idempotente, sin borrar filas). Las invitaciones no se invalidan: solo dependen de `meeting_invitations.token_hash`, que no se tocó |
| **S2** | `applyActions`/`addToAssociationIfMissing` sumaban a **cualquier** asociación activa | El valor del campo «asociación» es un string libre del visitante (el esquema Zod no lo restringe) y la única comprobación era `status='active'`: bastaba un UUID de otra unidad | Compuerta en el servidor `isAssociationAllowedForForm` (misma regla SQL que la lista que ve el visitante: activa y de la unidad del formulario o sus dependientes). Aplicada en los 5 llamadores (`submit.ts` ×2, `duplicates.ts` ×2, `submissions.ts` ×2). Además `addAssociationAction` rechaza al configurar una asociación fuera de la unidad del formulario. Un id fuera de alcance/inexistente/mal formado se ignora sin error: el envío se procesa y no se revela qué asociaciones existen |
| **S3** | Sin protección contra envíos automáticos | `submitForm` solo tenía el tope por slug/IP | Honeypot (`__website_url`, fuera de pantalla, `aria-hidden`, `tabIndex=-1`; se contesta «gracias» sin guardar). Tiempo mínimo de llenado 1,5 s medido con la hora del **servidor** (si falta o es inverosímil, se deja pasar: páginas abiertas antes del deploy siguen andando; se pide reintentar, no se descarta en silencio). Tope por persona: 5 envíos del mismo DNI por formulario cada 60 min, con el DNI **hasheado** (nunca en claro). El reintento del mismo envío (misma clave de idempotencia) no consume cupo. Tope por formulario subido de 60 a 600 por 10 min. **Sin CAPTCHA** |
| **S4** | `x-forwarded-for[0]` en 10 sitios | Con nginx `$proxy_add_x_forwarded_for` el valor de la izquierda lo escribe el cliente: rotándolo se evadía todo límite por IP | `lib/security/client-ip.ts`: se toma la entrada `hops` desde la **derecha** (`SUTECBA_TRUSTED_PROXY_HOPS`, default 1). Valida con `isIP`, IPv4 mapeada → IPv4, IPv6 agrupada por /64, nunca devuelve algo que rompa la columna `inet`. Los 10 sitios usan `resolveClientIp`/`getRequestClientIp`. `X-Real-IP` no se usa |
| **S5** | Límite no atómico y sin limpieza | `check` (SELECT) y `record` (INSERT) separados por todo el trabajo del endpoint: una ráfaga de N pedidos pasaba completa | `consumePublicLinkAttempt`: una transacción con locks consultivos por clave (orden fijo, sin deadlock) que cuenta e inserta. `settlePublicLinkAttempt` completa `succeeded`. Retención con `purge_public_link_attempts` (30 días, lotes de 5000, piso de 1 día, `SECURITY DEFINER`: la app **no** recibe `DELETE`). Se corrigieron umbrales que bloqueaban a gente legítima (ver §6) |
| **S6** | `meetings.view` bastaba para emitir el QR operativo y buscar personas | `/api/reuniones/[id]/qr` y `/live` pedían solo `meetings.view`, que tiene hasta **LECTURA** | Permiso nuevo `meetings.accredit` exigido en: ruta del QR, ruta del panel/búsqueda, página `/asistencia`, enlace «QR y asistencia», y **dentro** de `getLivePanelData`/`quickSearchForAccreditation`. Alcance: sigue exigiéndose reunión de la unidad propietaria (`canAccessMeeting`) y personas dentro del alcance del usuario |
| **S7** | `SUTECBA_QR_SECRET` opcional | `lib/db/env.ts` lo declaraba `optional()`; qr.ts/session-tokens.ts fallaban recién al primer uso | `lib/attendance/qr-config.ts`: obligatorio y ≥32 caracteres con QR habilitado; **falla cerrado** al usarlo en cualquier entorno; `instrumentation.ts` hace fallar el arranque **en producción** sin secreto válido: **el proceso queda en pie pero todas las rutas responden 500** (verificado con la build de Next 15.5; PM2 sigue mostrándolo «online», por eso el despliegue incluye un chequeo previo y una verificación HTTP posterior). Opt-out explícito y literal `SUTECBA_QR_DISABLED=true`. No imprime ni rota el secreto |
| **S8** | Centinela solo buscaba texto en `acciones.ts` | Dejaba fuera `app/(protegido)/actions.ts` y `personas/[id]/timeline-actions.ts` (también «use server»), no miraba rutas ni endpoints públicos | `tests/centinela/surface-behavior.test.ts` **ejecuta** cada acción y ruta sin sesión; ver §4 |

### 1-bis. Correcciones posteriores al preflight (2026-10-20)

**(1) Permisos de la función de limpieza (migración 0046).** `REVOKE ALL ... FROM PUBLIC` no quita los grants explícitos que Supabase da por defecto a
`anon`, `authenticated` y `service_role` en funciones nuevas (`ALTER DEFAULT PRIVILEGES`): sin más, la Data API habría podido invocar la limpieza. Ahora la 0046:
revoca de PUBLIC y de cada uno de esos tres roles que exista en la instalación; concede `EXECUTE` **únicamente** a `sutecba_app`; y termina con un bloque de
**verificación que aborta la migración** (transaccional, no queda nada a medias) si (a) la función no es `SECURITY DEFINER`, (b) su dueño no es el dueño de la
tabla ni puede borrar de ella, (c) queda **cualquier otro** grantee con `EXECUTE` (nombra al rol), o (d) `sutecba_app` no puede ejecutarla. Probado con
privilegios por defecto de Supabase simulados, con un rol intruso y con un dueño distinto (`f0-security.test.ts`, bloque «0046»), y con `SET ROLE sutecba_app`
(`scripts/verify-f0-copy.ts`).

**(2) Asociaciones al publicar.** `publishForm` y la reactivación de una versión (`changeFormStatus → published`) rechazan una configuración con acciones «sumar a
asociación» que apunten a una asociación fuera de la unidad del formulario, inactiva, inexistente o con id mal formado. El mensaje al operador es accionable
(«No se puede publicar: la acción «Sumar a una asociación» n.º 2 («Nombre») apunta a una asociación que no pertenece a la unidad del formulario, está inactiva o
ya no existe. Quitá esa acción o reemplazala…»), lista todas las acciones inválidas, **muestra el nombre solo si quien publica tiene alcance sobre esa asociación**
y **nunca muestra ids**. El formulario queda como estaba (sin versión nueva). La validación del servidor al procesar respuestas públicas se conserva: ignora en
silencio lo inválido y no revela nada al visitante.

**(3) Byte nulo y sustitutos sueltos.** Se midieron todos los puntos públicos con un byte nulo; fallaban con error 500: los valores de los campos del formulario
(`jsonb`), la clave de idempotencia (argumento de la Server Action, controlable por el cliente), el `slug` (página y envío), el email del check-in y el
User-Agent guardado. Ahora: un campo con texto no guardable se rechaza con «Contiene caracteres no válidos.» **en ese campo** (no se "limpia" en silencio, porque quitar un
NUL de «4011\0 1222» fabricaría un valor que la persona no escribió); la clave de idempotencia inválida pide recargar la página; slug, email/apellido del check-in y email del login con
texto no guardable dan la **misma respuesta que un dato inexistente**; el User-Agent inválido simplemente no se guarda. Solo se rechazan `U+0000` y mitades de par UTF-16
sueltas: acentos, ñ, emojis completos, saltos de línea, tabulaciones y símbolos pasan **sin alteración** (prueba de regresión que compara byte a byte lo guardado).
Los tokens de invitación, de QR y de baja ya eran inocuos (se procesan en memoria o se hashean antes de llegar a la base).

### Matriz del permiso `meetings.accredit` (mínimo privilegio)

| Rol | `meetings.view` | `meetings.accredit` | Efecto |
|---|---|---|---|
| MASTER_GLOBAL | sí | **sí** | sin cambio |
| ADMIN | sí | **sí** | sin cambio |
| OPERADOR | sí | **sí** | sin cambio |
| REUNIONES | sí | **sí** | sin cambio (es su función) |
| LECTURA | sí | **no** | **deja de poder** emitir el QR y buscar para acreditar; sigue viendo reuniones |

Nadie que hoy opera la acreditación la pierde. Regenerar el QR (`regenerateQrSecret`) sigue exigiendo `meetings.change_status`, sin cambio.

---

## 2. Archivos modificados

**Nuevos:** `lib/security/client-ip.ts`, `lib/security/request-ip.ts`, `lib/security/text-safety.ts`, `lib/attendance/qr-config.ts`, `instrumentation.ts`,
`db/migrations/0046_public_link_attempts_hardening.sql`, `db/migrations/0047_meetings_accredit_permission.sql`,
`scripts/preflight-f0.ts` y `scripts/verify-f0-copy.ts` (ambos de solo lectura / sobre una copia descartable; ver `docs/F0-PREFLIGHT-VPS-PROCEDIMIENTO.md`),
`docs/F0-NGINX-PROPUESTA.md`, `docs/F0-PREFLIGHT-VPS-PROCEDIMIENTO.md`, `docs/F0-PREFLIGHT-2026-10-20.md`, este documento y 7 archivos de tests (§4).

**Modificados:** `lib/security/public-rate-limit.ts` (reescrito), `lib/meetings/public.ts`, `lib/attendance/{checkin,live,qr,session-tokens}.ts`,
`lib/forms/{submit,apply,queries,commands,duplicates,submissions}.ts` (`commands.ts`: validación al publicar), `lib/mailing/unsubscribe-limit.ts` (solo la IP y el limitador; **el
comportamiento de Mailing no cambia**), `lib/permissions/catalog.ts`, `lib/db/env.ts`, `app/f/[slug]/{actions,page,FormRenderer}`,
`app/api/reuniones/[id]/{qr,live}/route.ts`, `app/(protegido)/reuniones/[id]/{page,asistencia/page}.tsx`, los 6 sitios de IP restantes en
`app/login`, `app/reunion`, `app/api/unsubscribe`, `app/unsubscribe`; `.env.example`, `SUTECBA_CONTEXTO.md`, `SUTECBA_SEGURIDAD.md`;
`app/login/actions.ts` (también el email con texto no guardable); tests existentes ajustados: `tests/integration/mailing.test.ts` (ya no pinta el «primer valor» como correcto),
`tests/unit/permission-modules.test.ts` (permiso nuevo), `tests/integration/forms.test.ts` (tope por formulario) y `tests/integration/pglite-local.test.ts` (23 migraciones, 47 permisos).

No se tocaron: datos, Personas, participaciones, semáforo, Mailing (envío, cola, proveedores, webhooks), nginx, PM2, VPS.

---

## 3. Migraciones (creadas, **no ejecutadas** en producción)

**0046 — `public_link_attempts`** (aditiva, idempotente, transaccional, `lock_timeout 10s`)
1. `UPDATE` de `identifier` → hash `h1:…` solo en los scopes con token (`invitation_*`, `checkin_qr`) y solo si aún no tiene el prefijo. Sin borrar filas; `scope`, `ip_address`, `succeeded`, `created_at` intactos.
2. `GRANT UPDATE (succeeded)` a nivel de **columna** a `sutecba_app`.
3. Índice por `created_at`; función `purge_public_link_attempts(int)` `SECURITY DEFINER` con `search_path` fijo; `REVOKE` de PUBLIC, `anon`, `authenticated` y `service_role` (los que existan); `EXECUTE` **solo** para `sutecba_app`; y un bloque de verificación que **aborta la migración** si el resultado no es exactamente ese (ver §1-bis).

**0047 — permiso `meetings.accredit`** (aditiva, idempotente): inserta el permiso y lo asigna a MASTER_GLOBAL, ADMIN, OPERADOR, REUNIONES. No toca usuarios, sesiones ni `permissions_version` (los permisos se leen del rol en cada pedido).

Ninguna usa `DROP TABLE/COLUMN`, `TRUNCATE` ni `ALTER COLUMN TYPE`: el guard de migraciones no pide `--allow-destructive`; en producción exige `--yes`.

---

## 4. Pruebas

Nuevas (todas con comportamiento real sobre PGlite, sin búsquedas de texto):

| Archivo | Qué prueba |
|---|---|
| `tests/unit/client-ip.test.ts` (11) | S4: falsificación, rotación del encabezado, hops 0/1/2, IPv6 /64, IPv4 mapeada, basura, encabezado gigante, `X-Real-IP` ignorado |
| `tests/unit/qr-config.test.ts` (8) | S7: producción sin/con secreto corto/válido, opt-out literal, fuera de producción, falla cerrado, el mensaje no contiene el secreto |
| `tests/integration/f0-security.test.ts` (52) | S5 concurrencia (40 pedidos simultáneos ⇒ pasan exactamente N), ventana, tope de fallidos, `settle`, retención; S1 sin token en claro en view/respond/check-in/QR, compatibilidad, **la migración 0046 re-ejecutada sobre datos históricos**; S2 asociaciones válidas / de otra unidad / inactivas / UUID inexistente / texto manipulado / acción vieja inyectada / configuración; S3 honeypot, tiempo, DNI repetido, reintento idempotente, wifi compartido; S6 matriz en catálogo **y base**, 401/403/404/200 por rol y alcance, UUID manipulado, defensa en la librería; **publicar con asociaciones fuera de alcance** (otra unidad, inactiva, inexistente, mal formada, varias, nombre solo con alcance, sin ids, reactivación de versión guardada, corrección y publicación válida); **permisos de la función de limpieza** (privilegios por defecto de Supabase simulados, rol intruso, dueño distinto, aborto de la migración); **byte nulo y sustitutos sueltos** en cada campo, casillas, idempotencia, slug, check-in, User-Agent, y la regresión de respuestas válidas |
| `tests/integration/public-endpoints-f0.test.ts` (10) | Punta a punta por las Server Actions y rutas reales: la IP registrada es la del proxy aunque el cliente falsifique el encabezado; honeypot/tiempo por `FormData`; invitación, baja y login; byte nulo por la acción del formulario y por el login |
| `tests/integration/preflight-f0.test.ts` (6) | `scripts/preflight-f0.ts`: estado limpio, filas a sanear, formularios publicados/configurados fuera de alcance (BLOCKER/WARNING), predicción de aborto de la 0046 por grantees por defecto, migraciones pendientes, solo lectura y sin datos personales |
| `tests/integration/verify-f0-copy.test.ts` (4) | `scripts/verify-f0-copy.ts`: ~26 comprobaciones con `SET ROLE sutecba_app`, siempre revertidas; detecta DELETE directo, EXECUTE de `anon`/PUBLIC, tokens sin sanear, filas perdidas y permiso mal asignado |
| `tests/centinela/surface-behavior.test.ts` (19) | S8: **todas** las Server Actions de `app/(protegido)` (incluidas `actions.ts` y `timeline-actions.ts`) rechazan sin sesión y no tocan la base antes de autorizar; todas las rutas están clasificadas (pública con motivo / protegida) y las protegidas responden 401 sin tocar la base. Una ruta o acción nueva sin guard rompe el test |

**Resultados (local, PGlite descartable; ninguna base real):**

| Verificación | Resultado |
|---|---|
| Suite completa Vitest | **86 archivos pasan, 3 omitidos · 1260 pruebas pasan, 0 fallan, 25 omitidas · EXIT 0** (antes de F0: 1150 / 0 / 25; +110 pruebas) |
| `npm run typecheck` | limpio |
| `npm run build` (local, `pipefail`) | exit 0; `instrumentation.js` compilado |
| Ensayo con el rol real `sutecba_app` (`SET ROLE`) sobre un esquema 0001–0047 | 23/23 PASS (y `verify-f0-copy.ts` por CLI: 26/26) |
| Compatibilidad hacia atrás (suite de `553ab60` contra el esquema con 0046/0047) | 1139 pasan; 2 fallos esperados de conteo/catálogo y 1 timeout de arranque que pasa solo (ver preflight §6) |
| Regresión de formularios, invitaciones, check-in/QR, Mailing (SES y Resend) | incluida en la suite completa, sin fallos |

Cuatro pruebas existentes se ajustaron **a propósito** porque fijaban el comportamiento corregido: `forms.test.ts` (el tope por formulario pasó de 60 a 600; ahora prueba el tope por IP de 300), `pglite-local.test.ts` (23 migraciones, 47 permisos), `permission-modules.test.ts` (permiso nuevo) y `mailing.test.ts` (ya no da por bueno el «primer valor» del encabezado). Las pruebas de límite de identificación fallida de `attendance.test.ts` y `sensitive-and-public.test.ts` **pasan sin cambios** (se conservó el freno de 40 fallidos).


---

## 5. Compatibilidad con invitaciones y formularios existentes

- **Invitaciones:** el acceso se resuelve por `meeting_invitations.token_hash`, que no se modificó; los enlaces ya enviados siguen funcionando (probado: la migración se aplica sobre filas con tokens en claro y el mismo token sigue abriendo). Lo único que cambia es qué se guarda en el rastro del límite.
- **Formularios publicados:** siguen funcionando. Páginas abiertas antes del deploy envían sin `__rt` ni trampa y se aceptan. **Excepción a verificar antes de desplegar (preflight C3/C4):** un formulario cuya acción apunte a una asociación de **otra** unidad hoy suma personas y tras F0 dejará de hacerlo (es el defecto S2; el envío se procesa igual), y **su próxima publicación será rechazada** con un error claro hasta corregir la configuración.
- **QR:** los tokens y el secreto no cambian; los QR ya impresos/mostrados siguen válidos.
- **Mailing:** sin cambios de comportamiento. La baja pública usa el mismo identificador y los mismos umbrales; solo cambia de dónde sale la IP.

---

## 6. Cambios de umbrales (decisión a revisar)

Se detectó, además de lo pedido, que algunos topes **bloqueaban a personas legítimas** en un acto con wifi compartido, porque el identificador efectivo era «la reunión» o «la IP». Se ajustaron preservando el freno a quien falla:

| Scope | Antes | Ahora |
|---|---|---|
| `checkin_qr` (identificador = prefijo del QR = **toda la reunión**) | 60 / 10 min por reunión; 200 por IP | 1500 por reunión; 400 por IP |
| `checkin_identify` (identificador = reunión + IP) | 40 / 300 | 300 / 400 **y tope de 40 intentos fallidos** por IP y reunión (igual que antes para quien prueba DNI+apellido) |
| `checkin_confirm` | 60 / 300 | 300 / 400 |
| `form_submit` (por formulario) | 60 / 300 | 600 / 300 + tope por persona (5 por DNI/60 min) |

---

## 7. Riesgos residuales y hallazgos adicionales (no se amplió el alcance)

| Sev. | Hallazgo | Estado |
|---|---|---|
| Media | **Verificar nginx y que la app no sea alcanzable sin nginx**: si hubiera otro proxy/CDN delante, `hops=1` agrupa a todos en una IP; si el puerto de Next está expuesto, un cliente escribe todo `X-Forwarded-For`. Ver `docs/F0-PREFLIGHT-VPS-PROCEDIMIENTO.md` bloque A | **Pendiente (BLOCKER hasta verificar)** |
| Media | **PGlite no hace cumplir `GRANT` ni RLS por sí solo**: se cubrió con `SET ROLE sutecba_app` (26 comprobaciones) y con la verificación interna de la 0046. Lo que PGlite **no** reproduce —privilegios por defecto de Supabase y dueño real de los objetos— lo cubren el preflight C6/C8 (catálogo real, solo lectura) y el aborto de la propia 0046 | Pendiente de ejecutar sobre producción (solo lectura) |
| Baja–Media | `searchPersonForInvitationAction` y las búsquedas de asociaciones exigen solo sesión (sin permiso): devuelven nombres dentro del alcance | Documentado, **no corregido** |
| Baja–Media | El límite de **login** (`lib/auth/rate-limit.ts`) sigue siendo comprobar-y-después-registrar (no atómico). Lo mitiga el costo del hash de contraseña y el tope por cuenta | Documentado, **no corregido** |
| Baja | ~~Un `NUL` (`\u0000`) en un campo público provocaba error 500~~ | **Corregido** (§1-bis 3) |
| Baja | Tope por formulario/IP sigue siendo un tope de volumen, no una defensa contra un botnet distribuido: sin CAPTCHA (decisión del pedido). El rate limit de nginx (propuesta §3.3) lo complementa | Aceptado |
| Info | `regenerateQrSecret` exige `meetings.change_status` y no `meetings.accredit`; hoy coinciden en todos los roles | Aceptado |

---

## 8. Procedimiento de despliegue propuesto (cada paso lo autoriza y ejecuta el titular, uno por vez, con guarda de hostname)

0. **Preflight (obligatorio, solo lectura sobre producción; nada se modifica)** — `docs/F0-PREFLIGHT-VPS-PROCEDIMIENTO.md`, un bloque por vez, todos en PASS:
   - **A** nginx, cadena de proxies, IP efectiva y exposición del puerto de Next.js → fija `SUTECBA_TRUSTED_PROXY_HOPS`.
   - **B** `SUTECBA_QR_SECRET` presente y ≥32 caracteres, sin imprimirlo (si falta o es corto, **no desplegar**: el sitio respondería 500 en todas las rutas con el proceso «online»; no se rota ni se cambia el existente).
   - **C** consultas de solo lectura: formularios publicados/configurados con asociaciones fuera de alcance (deben ser 0), dueño de la tabla y privilegios por defecto (predicen si la verificación de la 0046 pasará), tamaño de la tabla, IP históricas.
   - **D** ensayo de 0046/0047 sobre una restauración aislada (`restore-logical-backup.ts --keep` + `verify-f0-copy.ts`), sin usar la base productiva como destino.
1. Backup lógico + ensayo de restauración (rutina habitual) y `.next` de respaldo.
2. `git pull --ff-only` del commit F0 (que se autorizará aparte).
3. Migraciones: `npm run migrate -- --yes` (0046 y 0047). La 0046 se verifica a sí misma y **aborta sin dejar nada a medias** si los permisos de la función no son exactamente los previstos. Después, solo lectura: repetir C6/C8 del preflight y comprobar `has_function_privilege` para `anon`, `authenticated`, `service_role` (todos `false`).
4. `npm run build` con `pipefail`; reinicio de **un** proceso a la vez con la cola de Mailing vacía (el worker no cambia).
5. Verificación funcional: formulario público de prueba; invitación de prueba; con un usuario LECTURA, `/api/reuniones/<id>/qr` → 403; con REUNIONES → 200. Comprobar en la base que `public_link_attempts.identifier` nuevo empieza con `h1:` y que `ip_address` es la IP real y no la de nginx.
6. Observación 24 h: tasa de `rate_limited` en `form_submit` y `checkin_*` (los topes están en §6).

## 9. Plan de reversión

- **Código:** volver al commit anterior (`553ab60`), `npm run build`, reinicio. Es compatible con la base ya migrada: 0046 y 0047 son aditivas y el código viejo las ignora (el código viejo sigue pidiendo `meetings.view` para el QR).
- **Base** (solo si hiciera falta; normalmente no):
  - 0047: `delete from role_permissions where permission_id = (select id from permissions where key = 'meetings.accredit'); delete from permissions where key = 'meetings.accredit';` (después de volver al código anterior).
  - 0046: `revoke update (succeeded) on public_link_attempts from sutecba_app; drop function public.purge_public_link_attempts(integer); drop index public_link_attempts_created_at_idx;` (al borrar la función desaparecen también sus permisos). El saneamiento de identificadores **no se revierte** (justamente se eliminó el valor sensible); el código viejo calcula identificadores en claro y simplemente no coincidirá con los hasheados dentro de la ventana de 10 minutos.
- **Variables:** `SUTECBA_QR_DISABLED=true` permite iniciar una instalación sin QR si hiciera falta salir de un apuro; `SUTECBA_TRUSTED_PROXY_HOPS` se corrige sin tocar código.
- Respaldo previo y `.next` de respaldo según la rutina de despliegue.
