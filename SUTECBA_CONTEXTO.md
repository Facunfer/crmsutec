# SUTECBA CRM — Documento de contexto completo

> Pensado para que alguien (o una IA) que **nunca vio el proyecto** entienda qué es, cómo funciona, qué se hizo, dónde estamos parados y qué falta. Fecha de corte: 2026-09-20.
> No contiene secretos (contraseñas reales, tokens, claves). Los valores sensibles viven solo en el `.env` del servidor.

---

## 1. Qué es esto

Un **CRM web nuevo e independiente para SUTECBA**, un sindicato del sector público de la Ciudad de Buenos Aires. Sirve para gestionar:

- **Personas** (afiliados, referentes, delegados, contactos), con datos de contacto y organismo donde trabajan.
- **Asociaciones** (grupos/agrupaciones de personas con responsables).
- **Reuniones** con invitaciones, confirmación de asistencia y **check-in por QR**.
- **Formularios** públicos armados por el usuario, con deduplicación de personas.
- **Visualización**: dashboard con gráficos.
- **Administración**: usuarios, roles/permisos, organismos, campos personalizados.

Existe otro CRM de referencia (`portal-crm`, de **otro cliente**, en `C:\Users\usuario\Downloads\portal-crm`). Se usó **solo como referencia de patrones** y es de **solo lectura**. SUTECBA no comparte nada con él.

## 2. Reglas no negociables (R1–R8)

| Regla | Contenido |
|---|---|
| R1/R2 | Base de datos, credenciales e infraestructura **propias** de SUTECBA. Nunca se usan variables del CRM de referencia (`SUPABASE_*`, `DATABASE_URL`, etc.). |
| R3 | Cero contenido, marca o textos de otros clientes. |
| R4 | Ninguna credencial en el navegador. |
| R5 | Permisos **del lado del servidor en 3 capas** (menú, página, acción). "Esconder un botón no es un permiso". |
| R6 | Nada simulado ni falso: si una función existe, funciona de verdad. |
| R7 | La afiliación sindical es dato sensible (Ley 25.326 de Protección de Datos Personales, Argentina). DNI/email/teléfono se enmascaran salvo permiso explícito. |
| R8 | Prácticas conservadoras: sin borrados físicos de datos de trazabilidad; FKs `RESTRICT`, no `CASCADE`/`SET NULL`. |

Cuándo frenar y preguntar al dueño: decisiones estructurales, destructivas o de infraestructura en la nube. Las decisiones técnicas rutinarias las toma el desarrollador y las documenta en `SUTECBA_ARCHITECTURE.md`.

## 3. Stack técnico

- **Next.js 15.5** (App Router) + **React 19** + **TypeScript 5.5**.
- **Tailwind 3.4** con paleta de marca (`brand-50..900`, `estado-ok/alerta/riesgo`).
- **Zod 4** para validación; **Kysely** como query builder.
- **Base de datos**: **PGlite** (Postgres embebido en WASM, `@electric-sql/pglite` + `kysely-pglite`) para dev/demo. Postgres real soportado vía `SUTECBA_DATABASE_URL` (**sin probar aún**). Decisión D2.
- **AG Grid Community 36** (tabla de Personas), **Recharts 3** (gráficos), **qrcode.react** (QR).
- **Vitest 3** para tests: 21 archivos, **148 tests, todos pasando**. Cada test de integración crea su propio directorio PGlite temporal (`.data/pglite-test-<uuid>`), `fileParallelism:false`.
- Scripts (`package.json`): `dev` (`next dev -p 3100`), `build`, `start` (`next start -p 3100`), `migrate`, `seed`, `create-admin` (vía `tsx scripts/*.ts`), `test`, `typecheck`.

## 4. Estructura del repositorio

Raíz: `C:\Users\usuario\Downloads\sutecba` (en el VPS: `/opt/sutecba`). GitHub: `https://github.com/Facunfer/crmsutec`, rama `master`.

```
app/
  (protegido)/        páginas que exigen sesión: dashboard, personas, asociaciones,
                      reuniones, formularios, visualizacion, administracion/*, sin-permiso
  login/              login y cambio de contraseña obligatorio
  f/[slug]/           formularios públicos
  reunion/            check-in por QR e invitaciones públicas por token
  api/                endpoints (QR rotativo, panel en vivo, exportaciones)
components/           sidebar, gráficos, UI compartida
lib/
  db/                 env, cliente Kysely, migraciones
  auth/ permissions/  sesiones, RBAC (catalog.ts = catálogo de permisos)
  people/ associations/ meetings/ attendance/ forms/ analytics/
  organizations/ users/ audit/ notifications/ scope/ security/ settings/
  datetime.ts         zona horaria de negocio
db/migrations/        0001..0011 (SQL)
scripts/              migrate, seed, create-admin
tests/                unit, integration, centinela
```

Documentos: `SUTECBA_ARCHITECTURE.md` (decisiones D1–D18), `SUTECBA_DATABASE.md` (esquema y peculiaridades), `SUTECBA_SEGURIDAD.md` (checklist de seguridad), `SUTECBA_DESPLIEGUE.md` (guía de VPS).

## 5. Modelo de seguridad

### Autenticación
- Usuarios propios con contraseña **bcrypt**. Sin compatibilidad con texto plano (D4).
- Tabla `sessions`: token aleatorio de 32 bytes, guardado como **SHA-256**, validado contra la DB en **cada request**. Cookie `sutecba_session` `httpOnly`, `secure` en producción, `sameSite=lax`.
- `permissions_version` en el usuario: al cambiar sus permisos, sus sesiones se invalidan al instante.
- Rate limit de login guardado en tabla. Cambio de contraseña forzado en el primer ingreso.

### Autorización (RBAC)
- Catálogo de ~30 permisos en `lib/permissions/catalog.ts`, sincronizado por un seed idempotente (los permisos nunca se borran; `role_permissions` se resincroniza completo).
- Roles: `MASTER_GLOBAL`, `ADMIN`, `OPERADOR`, `REUNIONES`, `LECTURA`.
- `can(user, "clave")`. Tres capas: el menú oculta, la página exige, cada **server action** vuelve a exigir (`requireUser(`). Un **test centinela** escanea todos los `acciones.ts` y falla si alguno no llama a `requireUser(`.

### Enmascarado de datos sensibles
- `people.view_sensitive` controla ver DNI/email/teléfono. `lib/people/masking.ts` (`applyMasking`) **debe aplicarse en TODA superficie** que muestre esos campos. La Etapa 10 encontró y corrigió tres bypasses (edición de persona, búsqueda de personas para agregar a asociaciones, cola de revisión de formularios). `updatePerson` preserva los valores sensibles si el actor no tiene el permiso.

### Otros
- Auditoría: `lib/audit/log.ts` es el único camino de escritura; `audit_logs` es **append-only** por trigger de DB.
- Export CSV protegido contra inyección de fórmulas (`sanitizeCsvCell`).
- Decisión sobre RLS de Postgres documentada en `SUTECBA_SEGURIDAD.md`.

## 6. Módulos y cómo funcionan

- **Personas**: ABM completo, grilla AG Grid, filtros, export, alta masiva a asociaciones, búsqueda (extensiones de búsqueda en migración 0009), campos personalizados en `people.custom_fields` (JSONB, claves de `person_field_definitions`). *Falta UI para editar `custom_fields` desde la ficha de persona.*
- **Organismos**: catálogo de organismos públicos.
- **Asociaciones**: ABM, miembros, responsables, alta masiva desde Personas.
- **Reuniones**: máquina de estados `draft → scheduled → in_progress → finished / cancelled` (más `overdue_unclosed` derivado). Invitaciones con token hasheado, respuesta pública, retiro de invitación.
- **Asistencia / QR** (`lib/attendance/*`): QR con tokens HMAC firmados con `SUTECBA_QR_SECRET` (mín. 32 caracteres), ventanas rotativas de 45 s, secreto por reunión derivado de `qr_secret_version`. Check-in en dos pasos (identificar → confirmar con token pendiente firmado), cookie de sesión de check-in firmada, rate limit en `public_link_attempts`, unicidad `(meeting_id, person_id)` para concurrencia. Panel en vivo y **corrección manual con motivo obligatorio**.
- **Formularios** (`lib/forms/*`): el constructor edita tablas borrador; al publicar se crea un snapshot **inmutable** en `form_versions`; la página pública y el procesamiento leen ese snapshot. Política de identificación (`matchFields`), política de actualización (`fill_empty_only` / `always_flag_for_review`), `person_duplicate_candidates` (**nunca se fusiona automáticamente**, hay cola de revisión), `idempotency_key` único, export CSV.
- **Visualización** (`lib/analytics/queries.ts`): gráficos reales de personas, asociaciones, reuniones y formularios; los meses se calculan en horario -03:00.
- **Administración**: usuarios, roles, organismos, campos personalizados. (Se **eliminaron** los módulos Auditoría y Configuración por pedido del dueño; la tabla `audit_logs` y el registro siguen existiendo.)
- **Notificaciones**: solo existe el proveedor `manual_link` (se genera un link para compartir a mano). No hay envío real de email/WhatsApp.

Zona horaria de negocio: `America/Argentina/Buenos_Aires`, offset fijo -03:00 (`lib/datetime.ts`; el SQL usa `at time zone '-03:00'`).

## 7. Variables de entorno

Validadas en `lib/db/env.ts` (Zod). Se lee `.env` con `process.loadEnvFile()` (arreglo posterior: antes los scripts sueltos no lo leían y reportaban `env=local`).

| Variable | Uso |
|---|---|
| `SUTECBA_ENV` | `local` (default) / `test` / `staging` / `production`. `production` exige `--yes` para `migrate`. |
| `SUTECBA_DATABASE_URL` | Postgres real (opcional; si falta se usa PGlite). |
| `SUTECBA_PGLITE_DATA_DIR` | Directorio de datos PGlite (default `.data/pglite-local`). |
| `SUTECBA_TZ` | Zona horaria. |
| `SUTECBA_QR_SECRET` | Secreto de los QR (≥32 chars). |
| `SUTECBA_PUBLIC_BASE_URL` | URL pública base (opcional). |
| `SUTECBA_SESSION_SECRET`, `SUTECBA_TOKEN_SECRET` | Declaradas pero **no usadas hoy**. |

## 8. Peculiaridades y trampas conocidas (¡leer antes de tocar!)

1. **PGlite comparte UNA sesión** entre "conexiones" → transacciones concurrentes se corrompían. Solución: mutex `serializePGliteTransactions` en `lib/db/client.ts` (solo PGlite).
2. `numUpdatedRows` no es confiable en PGlite: usar `.returning()`. `IN ()` vacío es inválido.
3. La conexión se cachea en `globalThis` porque los singletons de módulo no se comparten entre capas de Next.
4. **Nunca correr `migrate`/`seed`/`create-admin` con el servidor levantado**: dos procesos sobre el mismo directorio PGlite no se sincronizan (produce "split-brain": el usuario existe pero el login dice "Email o contraseña incorrectos").
5. **Matar el proceso a la fuerza puede corromper** `.data/pglite-local` (`RuntimeError: Aborted()`). Tratar la DB PGlite como **descartable**; recrear con `rm -rf .data/pglite-local && npm run migrate && npm run seed && npm run create-admin -- ...`.
6. Tras reiniciar el servidor, un navegador con la página vieja abierta muestra "Server Action not found": basta recargar.
7. `SUTECBA_ENV=production` marca la cookie como `secure` → **requiere HTTPS**; en HTTP plano el login "funciona" pero la sesión no se guarda (loop).
8. Al escribir `.env` en el VPS usar `cat >` (no `cat >>`) para evitar claves duplicadas.
9. `git add -A -- ':!.env'` devuelve exit 1 (aviso benigno) y rompe cadenas con `&&`.
10. `.data/` no debe subirse a git.

## 9. Qué se hizo (historial por etapa)

| Etapa | Contenido | Commit |
|---|---|---|
| 1 | Arquitectura inicial y esqueleto | `222e2e7` |
| 2 | Esquema completo, guardas de migraciones, seed idempotente | `7511418` |
| 3 | Login, RBAC, layout protegido, administración de usuarios | `1bdedf7` |
| 4 | Personas + catálogo de organismos | `8cc5d4b` |
| 5 | Asociaciones | `b4a67dc` |
| 6 | Reuniones, máquina de estados, invitaciones | `a8d0b6c` |
| 7 | QR y asistencia | `0d7411e` |
| 8 | Formularios, deduplicación | `648e25b` |
| 9 | Visualización (gráficos) | `cabf231` |
| 10 | Checklist de seguridad (3 fallas de enmascarado corregidas) | `8125022` |
| — | Se quitan Auditoría y Configuración | `77e1203` |
| — | Guía de despliegue en VPS (y adaptada a Hostinger) | `bfcfdf1`, `f2c1bb3` |
| — | Se quitan textos explicativos tipo comentario del front | `ff82cb2` |
| — | Scripts leen `.env` | `0cc0a63` |

(La etapa 3 incluye la decisión de no compartir nada con `portal-crm`; los detalles de cada decisión D1–D18 están en `SUTECBA_ARCHITECTURE.md`.)

## 10. Dónde estamos parados: despliegue

**Servidor**: VPS Hostinger KVM, Ubuntu 24.04, IP `145.223.92.253`, host `srv1457428.hstgr.cloud`, acceso root por la **Web console** del panel. **Es un VPS compartido** con otros servicios productivos del dueño (gestionados con PM2: consola, crm, enviowpp, mapa; y sitios nginx de otros dominios). **No se debe modificar ni borrar nada de esos servicios.**

**Estado actual de SUTECBA en el VPS**:
- Código clonado en `/opt/sutecba` desde GitHub; `npm install`, `migrate`, `seed`, `build` hechos.
- `.env` con solo `SUTECBA_ENV=production`, `SUTECBA_TZ=America/Argentina/Buenos_Aires` y un `SUTECBA_QR_SECRET` generado.
- Usuarios creados con `create-admin`: `prueba@prueba.com` (contraseña de prueba **débil**, `prueba1234`, que se debe cambiar y obliga a cambiarse en el primer login) y `persona@ejemplo.com` (a desactivar).
- **PM2** corre `sutecba` con `next start -p 3100 -H 127.0.0.1` (solo escucha en localhost; el puerto 3100 no es accesible desde afuera). `pm2 save` + startup con systemd.
- **nginx** (`/etc/nginx/sites-available/sutecba`, enlazado en `sites-enabled`): 80 → redirige a 443; 443 con TLS hace proxy a `127.0.0.1:3100`. `server_name sutecba.duckdns.org`.
- **DNS**: subdominio gratuito DuckDNS `sutecba.duckdns.org` apuntando a la IP del VPS.
- **TLS**: hoy con **certificado autofirmado** → el navegador muestra "La conexión no es privada".
- **ufw**: dejado **inactivo a propósito** (el dueño pidió no activarlo, porque el VPS aloja otros servicios y podría cortarles el acceso).

**Paso inmediato pendiente**: obtener certificado real de Let's Encrypt:

```bash
certbot --nginx -d sutecba.duckdns.org
```

Después verificar `https://sutecba.duckdns.org/` sin advertencia, loguearse con `prueba@prueba.com`, y comprobar la renovación: `certbot renew --dry-run`.

**Actualizar el código en el VPS**: `cd /opt/sutecba && git pull && npm install && npm run build && pm2 restart sutecba`.

## 11. Qué falta

1. **Terminar HTTPS confiable** (certbot, ver arriba) y verificar el login desde afuera.
2. Cambiar la contraseña débil de prueba y desactivar `persona@ejemplo.com`.
3. **Actualizar `SUTECBA_DESPLIEGUE.md`** con lo aprendido: `cat >` para `.env`, arreglo de carga de `.env`, `-H 127.0.0.1`, precauciones de VPS compartido, ufw inactivo, DuckDNS + certbot. Hoy todavía documenta el flujo con IP + certificado autofirmado y ufw activado.
4. **Postgres real**: hoy en producción corre PGlite (descartable, se puede corromper). Antes de cargar datos reales de afiliados hay que migrar a Postgres real (`SUTECBA_DATABASE_URL`); el código lo soporta pero **nunca se probó**, y hay que hacer backups.
5. UI en la ficha de Personas para editar `custom_fields`.
6. Proveedores reales de notificación (email/WhatsApp); hoy solo `manual_link`.
7. Documento legal `docs/datos-personales.md` (recomendaciones Ley 25.326 para R7) — previsto en el plan maestro, sin escribir.
8. Limpiar variables sin uso (`SUTECBA_SESSION_SECRET`, `SUTECBA_TOKEN_SECRET`) o usarlas.
9. Etapas posteriores a la 10 del prompt maestro no detalladas: revisar contra el plan original del dueño.

## 12. Cómo correrlo localmente (Windows)

```bash
cd C:\Users\usuario\Downloads\sutecba
npm install
npm run migrate
npm run seed
npm run create-admin -- --email=admin@ejemplo.com --name="Admin" --password="UnaClaveFuerte123!"
npm run dev        # http://localhost:3100
npm test           # ~2 minutos, 148 tests
npm run typecheck
```

Recordar: no correr `migrate/seed/create-admin` mientras `npm run dev` está activo.

## 13. Forma de trabajo con el dueño

- Se trabaja por **etapas**; el dueño dice "seguí con la etapa N".
- El dueño ejecuta los comandos del VPS él mismo desde la Web console y pega la salida; el asistente que trabaja en su Windows **no tiene acceso al VPS**, solo da comandos como texto.
- Idioma: español rioplatense.
- Al proponer cualquier cambio en el VPS compartido, verificar antes nombres y estado (no asumir), y no tocar otros servicios.
