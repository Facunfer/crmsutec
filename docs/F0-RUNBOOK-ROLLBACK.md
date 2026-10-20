# F0 — Runbook de rollback (volver al commit `553ab60`)

**Estado: PREPARADO, NO EJECUTADO.** Nada de esto se ejecuta sin decisión expresa del titular. Esta guía contempla **qué se revierte, qué no y cuándo detenerse**.

> **Principio rector.** F0 es **aditivo en la base**: 0046 y 0047 agregan una columna con permiso, un índice, una función, un permiso y sus asignaciones; **no borran ni transforman datos** (salvo reemplazar tokens de intentos antiguos por su hash). El código viejo `553ab60` **funciona sobre el esquema nuevo** (se corrió su suite completa contra él: 1139 pruebas pasan; los 3 desvíos son un conteo de migraciones, un permiso huérfano en un test de catálogo y un timeout de arranque que pasa solo). Por eso **el rollback normal es solo de código (+ el build anterior) y la base NO se toca.**

---

## 0. Qué se revierte y qué no

| Componente | ¿Se revierte? | Cómo | Riesgo |
|---|---|---|---|
| Código de la aplicación | **Sí** | `git reset --hard 553ab60` en `/opt/sutecba` (árbol limpio verificado) | Bajo: F0 sigue en `origin` y en el reflog |
| Build de Next (`.next`) | **Sí** | Restaurar `.next.pre-f0-553ab60` (sin recompilar) | Bajo |
| Proceso PM2 | **Sí, solo `sutecba`** | `pm2 restart sutecba` | Corte de segundos |
| `sutecba-mail` | **No** (no se tocó) | — | — |
| Migraciones 0046/0047 | **No** (se dejan aplicadas) | Son aditivas y compatibles | Ninguno con el código viejo |
| Datos / tablas | **No** | — | — |
| nginx, firewall, `.env`, otras aplicaciones | **No** | — | — |

Con el código viejo y el esquema nuevo **vuelve la capacidad original**: cualquier rol con `meetings.view` (incluido LECTURA) puede pedir el QR operativo (el defecto S6) y las IP se toman del primer valor de `X-Forwarded-For` (S4). Es un retroceso de seguridad **temporal y conocido**; el rollback es para recuperar el servicio, no para quedarse ahí.

---

## 1. Árbol de decisión (síntoma → acción)

| Síntoma | Cuándo aparece | Acción |
|---|---|---|
| El sitio responde `500` en todas las rutas, `Failed to prepare server`/`QrConfigError` en el log (el proceso figura `online`) | Tras el reinicio | **§2 rollback de código inmediato.** Causa probable: secreto de QR ausente/corto. No rotar ni imprimir el secreto: lo decide el titular |
| `pm2` muestra `errored`/reinicios en cascada | Tras el reinicio | §2 |
| `/login` u otras páginas dan `500` por otra causa | Tras el reinicio | §2 y guardar los logs (§5) |
| En `public_link_attempts` aparece `6.6.6.6`/`9.9.9.x` (IP falsa) o el límite no corta | Verificación 3.3 | §2 (la IP se toma del lado equivocado de la cadena) |
| El build falla | Paso 2.6 | **§4 build fallido** (el servicio viejo sigue; `.next` puede estar a medias) |
| La migración falla | Paso 2.4 | **§3 migración fallida** (no es rollback de código) |
| El chequeo de arranque da BLOCKER | Paso 2.3 | No se hizo nada todavía: corregir y reintentar; no hay nada que revertir |
| Una tabla que no debía cambiar cambió | Verificación 3.8 | **DETENERSE** (§6). No revertir la base |
| Dudas / comportamiento raro no listado | Cualquiera | Rollback de código (§2) es seguro y rápido; no tocar la base |

---

## 2. Rollback de código + build anterior (el procedimiento normal)

Tiempo: 1–3 minutos. **Antes** de empezar, guardar la evidencia (§5).

```bash
export EXPECTED_HOST="<hostname-del-VPS-de-SUTECBA>" ; export APP_DIR=/opt/sutecba ; export APP_NAME=sutecba
[ "$(hostname)" = "$EXPECTED_HOST" ] && echo "HOST OK" || echo "HOST EQUIVOCADO → PARAR"
cd "$APP_DIR"
git status --porcelain ; echo "--- (vacío = limpio) ---"     # si hay archivos modificados a mano: DETENER y preguntar
git rev-parse --short HEAD                                    # anotar el hash de F0 (para volver a desplegarlo luego)
ls -d .next.pre-f0-553ab60 && cat .next.pre-f0-553ab60/BUILD_ID && cat /root/f0-prev-build-id.txt
```
**Esperado:** árbol limpio, la copia `.next.pre-f0-553ab60` existe y su `BUILD_ID` es el anotado en el predeploy. **Si falta la copia:** ver «Sin copia» abajo.

```bash
# 1) volver el código (seguro: árbol limpio y F0 sigue en origin/master)
git reset --hard 553ab60
git rev-parse --short HEAD ; git log -1 --format='%h %s'

# 2) restaurar el build anterior (sin recompilar)
pm2 stop "$APP_NAME"
rm -rf .next
cp -a .next.pre-f0-553ab60 .next
cat .next/BUILD_ID

# 3) arrancar solo este servicio
pm2 start "$APP_NAME"        # (si no responde a «start», usar: pm2 restart "$APP_NAME")
sleep 8
pm2 describe "$APP_NAME" | grep -E "status|restarts|uptime"
```
**Esperado:** `HEAD` = `553ab60`; `BUILD_ID` = el anotado; `status online`.

**Verificar (2 minutos):**
```bash
for i in 1 2 3; do curl -s -o /dev/null -w "local /login → %{http_code}\n" http://127.0.0.1:3100/login; sleep 1; done
curl -s -o /dev/null -w "público /login → %{http_code}\n" https://sutecba.duckdns.org/login
pm2 logs "$APP_NAME" --lines 80 --nostream 2>&1 | grep -iE "Failed to prepare|QrConfigError|Error:" || echo "sin errores"
pm2 ls | diff - /tmp/f0-pm2-after.txt || true      # las demás aplicaciones no deben haber cambiado
```
**Esperado:** `200`, `200`, «sin errores». Si todavía hay `500`: **DETENER** (no seguir improvisando; el problema no es F0) y avisar.

**Sin copia de `.next`:** `git reset --hard 553ab60` y luego `set -o pipefail; npm run build 2>&1 | tee /tmp/f0-rb-build.log; echo BUILD_EXIT=${PIPESTATUS[0]}` y `pm2 restart "$APP_NAME"`; verificar igual.

> `git reset --hard` es destructivo **solo** para cambios locales no confirmados; por eso el paso previo exige árbol limpio. No usar `--force`, `git clean` ni `git checkout .` en el VPS.

---

## 3. Migración fallida (paso 2.4) — NO es un rollback de código

Las migraciones se aplican **una por una, cada una en su transacción con su registro**. Si una falla, **esa** no queda aplicada; las anteriores sí.

```bash
node /tmp/f0-readonly.cjs /opt/sutecba /tmp/f0-pre.sql | head -60      # P2: ¿qué migraciones figuran?
```
| Estado tras el fallo | Qué significa | Qué hacer |
|---|---|---|
| `ultima = 0045…`, ninguna de F0 | Falló la 0046 y se deshizo entera | Leer el mensaje. **No reintentar a ciegas.** El sitio sigue con el código viejo, sano. Consultar |
| `ultima = 0046…` | 0046 aplicada, falló la 0047 | El sitio sigue sano con el código viejo. La 0047 es idempotente; reintentar **solo** después de entender el error |
| Mensaje que empieza con `0046:` | La verificación interna de permisos abortó (dueño o grantee inesperado) | Es la protección funcionando: copiar el mensaje **completo** (nombra el rol) y consultar. **No** tocar permisos a mano sin decisión del titular |
| `lock timeout` / bloqueo | Otra sesión sostiene un lock sobre `public_link_attempts` | Esperar y reintentar; la tabla es chica |
En ningún caso se compila ni se reinicia con una migración a medias.

---

## 4. Build fallido (paso 2.6)

El proceso viejo sigue en pie pero `.next` pudo quedar incompleto.
```bash
cd /opt/sutecba
pm2 stop sutecba
rm -rf .next && cp -a .next.pre-f0-553ab60 .next
git reset --hard 553ab60        # solo si se quiere volver también el código (árbol limpio verificado)
pm2 start sutecba
```
Verificar como en §2. Si en cambio el build falló por un motivo corregible, **no** se reinicia con un build parcial: se restaura y se vuelve a intentar con el titular.

---

## 5. Evidencia a conservar antes de revertir
```bash
mkdir -p /root/f0-incidente && cd /root/f0-incidente
date -u > fecha.txt ; git -C /opt/sutecba rev-parse HEAD > commit.txt
pm2 describe sutecba > pm2-describe.txt ; pm2 logs sutecba --lines 400 --nostream > pm2-logs.txt 2>&1
cp /tmp/f0-migrate.log /tmp/f0-build.log . 2>/dev/null ; chmod 600 *
```
Los logs no deben compartirse sin revisar (pueden incluir rutas y mensajes de error; no incluyen secretos, pero se revisan antes de pegarlos).

---

## 6. Cuándo DETENERSE y NO intentar revertir la base

- **No se revierte la base automáticamente en ningún escenario.** Las migraciones son aditivas y compatibles: dejarlas aplicadas es lo seguro.
- **Restaurar el respaldo completo sobre producción** descarta todo lo escrito después del respaldo (sesiones, intentos, cualquier alta). Es una decisión **exclusiva del titular**, solo ante corrupción de datos demostrada, y nunca como respuesta a un error de aplicación.
- **Detenerse y consultar** si: cambian filas de tablas que F0 no toca (`people`, `meeting_participations`, `person_interactions`, `form_submissions`, Mailing…); aparece cualquier error de integridad referencial; el mensaje de una migración menciona un rol que no esperabas; los conteos del postdeploy no cuadran con la línea de base.
- **Limpieza manual del esquema de F0** (borrar la función, quitar el permiso, `revoke`): no forma parte del rollback. Solo si el titular lo decide expresamente. SQL, para referencia, **que no se ejecuta por defecto**:
  ```sql
  -- 0047 (después de volver al código anterior)
  DELETE FROM role_permissions WHERE permission_id = (SELECT id FROM permissions WHERE key = 'meetings.accredit');
  DELETE FROM permissions WHERE key = 'meetings.accredit';
  -- 0046 (la función desaparece con sus permisos)
  REVOKE UPDATE (succeeded) ON public_link_attempts FROM sutecba_app;
  DROP FUNCTION public.purge_public_link_attempts(integer);
  DROP INDEX public.public_link_attempts_created_at_idx;
  -- Los identificadores ya reemplazados por su hash NO se restauran (es justamente lo que no debía conservarse).
  ```

---

## 7. Compatibilidad del código viejo con lo que dejó F0

| Elemento | Con el código `553ab60` |
|---|---|
| `public_link_attempts` con identificadores `h1:…` | Se ignoran: el código viejo calcula identificadores en claro, así que los contadores de la ventana de 10 minutos arrancan de cero (efecto: nunca un bloqueo indebido) |
| Columna `succeeded` con UPDATE de columna, función de limpieza, índice | No se usan |
| Permiso `meetings.accredit` y 4 asignaciones | Quedan en la base sin efecto. **Efecto lateral:** el QR vuelve a pedir `meetings.view` |
| Variables `SUTECBA_QR_DISABLED` / `SUTECBA_TRUSTED_PROXY_HOPS` | El esquema de variables del código viejo no es estricto: las ignora |
| QR emitidos, sesiones de check-in, tokens de invitación | **Intercambiables** entre versiones (se probó firmar con una y verificar con la otra: 9/9) |
| Formularios publicados / respuestas guardadas por F0 | Se leen normalmente |

> **Trampa: NO ejecutar `npm run seed` con el código viejo.** El seed viejo quita de cada rol los permisos que su catálogo no conoce: borraría las 4 asignaciones de `meetings.accredit`. Como la 0047 ya figura como aplicada, **no se volvería a ejecutar** y, al desplegar F0 otra vez, el QR quedaría denegado a todos. Si por error ocurriera: ejecutar `npm run seed` **con el código de F0** (restituye las asignaciones desde el catálogo) o aplicar de nuevo el `INSERT` de la 0047 a mano con decisión del titular.

---

## 8. Volver a desplegar F0 después de un rollback
1. Entender y corregir la causa; presentar el resultado al titular.
2. Repetir la **Parte 1 (predeploy)** completa: `0046/0047` ya figuran aplicadas, así que el paso 1.9 cambia a «aplicadas = 2» y el paso 2.4 dirá «no hay migraciones pendientes» (correcto).
3. `git pull --ff-only` → chequeo de arranque (2.3) → build → reinicio solo de `sutecba` → verificación.
4. Si se había ejecutado un seed viejo (§7): `npm run seed` con el código de F0 antes de dar por terminado.
