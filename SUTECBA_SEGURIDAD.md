# Seguridad — CRM SUTECBA

> Etapa 10. Checklist completo referenciado desde la sección 6 de `SUTECBA_ARCHITECTURE.md`. Cada ítem se verificó leyendo el código real (no por inspección superficial) y, donde tenía sentido, con un test de regresión. Los hallazgos reales de esta etapa están marcados explícitamente — no son hipotéticos.

## 1. Aislamiento e independencia (R1, R2, R3)

| Ítem | Estado | Verificación |
|---|---|---|
| Base de datos, esquema y credenciales propias, sin nada compartido con `portal-crm` | ✅ | Repo separado desde el día uno (D1); `lib/db/env.ts` nunca lee `SUPABASE_*`/`DATABASE_URL` sin prefijo `SUTECBA_`. |
| `portal-crm` nunca se escribe | ✅ | Read-only por construcción: ningún módulo de SUTECBA importa desde `portal-crm`; `lib/db/guards.ts` bloquea explícitamente conectarse a los proyectos de otro cliente por nombre. |
| Cero contenido/branding/nombres cruzados | ✅ | Verificado con test centinela desde la Etapa 0; auditado a mano de nuevo en esta etapa (sin "comuna", "semáforo", nombres de otros clientes). |

## 2. Credenciales y secretos (R4)

| Ítem | Estado | Verificación |
|---|---|---|
| Ninguna variable `NEXT_PUBLIC_` con datos de base o secretos | ✅ | `grep -r "NEXT_PUBLIC_"` sobre todo el código: cero resultados. |
| `.env` nunca commiteado | ✅ | Solo `.env.example` (con placeholders) apareció alguna vez en el historial de git; `.gitignore` cubre `.env`/`.env.local`/`.env.*.local`. |
| Ningún secreto llega al bundle del cliente | ✅ | Barrido final de `.next/static` en un build de producción buscando `SUTECBA_QR_SECRET`, `SUTECBA_SESSION_SECRET`, `SUTECBA_TOKEN_SECRET`, `SUTECBA_DATABASE_URL`, `password_hash`, `token_hash`: sin coincidencias. Repetido en cada etapa que agregó un secreto nuevo (Etapa 7). |
| Contraseñas con hash fuerte, sin compatibilidad con texto plano | ✅ | bcrypt (D4), sin ninguna ruta que acepte comparación en texto plano — `tests/unit/passwords.test.ts`. |
| Tokens públicos (invitación, check-in) hasheados en base, nunca en claro | ✅ | D10; `token_hash` es lo único que se guarda, el valor en claro se muestra una sola vez al generarlo. |
| Sesión: token aleatorio de 256 bits, hasheado en base, validado contra la base en cada request (no JWT autocontenido) | ✅ | `lib/auth/session.ts` — revisado línea por línea en esta etapa. |
| Cookie de sesión `httpOnly`, `secure` en producción, `sameSite=lax` | ✅ | `lib/auth/cookies.ts`. |

## 3. Autenticación y fuerza bruta

| Ítem | Estado | Verificación |
|---|---|---|
| Rate limit de login por cuenta y por IP, guardado en tabla (no memoria) | ✅ | `lib/auth/rate-limit.ts`, verificado que está efectivamente invocado desde `app/login/actions.ts` (no solo definido y sin usar). |
| Longitud mínima de contraseña exigida en cambio/creación | ✅ | `validatePasswordStrength` en `lib/auth/passwords.ts`. |
| Cambiar/resetear contraseña invalida todas las sesiones anteriores | ✅ | D4, ya documentado y probado en etapas previas. |
| `permissions_version`: cambiar de rol o desactivar corta el acceso al instante, sin esperar el TTL de la sesión | ✅ | D4. |

## 4. Permisos — tres capas (R5)

| Ítem | Estado | Verificación |
|---|---|---|
| Cada página protegida llama a `requireUser()`/`requirePermission(...)` | ✅ | Auditoría exhaustiva de los 19 `page.tsx` bajo `app/(protegido)/**` en esta etapa: los 19 gatean correctamente, con la clave de permiso lógicamente correcta para su contenido. Ninguna depende solo del `requireUser()` del layout. |
| Cada Server Action llama a `requireUser()` antes de cualquier otra cosa | ✅ | Test centinela `tests/centinela/server-actions-guarded.test.ts`, ahora con 12 archivos `acciones.ts` escaneados (creció de 8 a 12 en las Etapas 8-9). |
| "Ocultar un botón no es un permiso": el comando de servidor reafirma el permiso, no confía en que la UI ya filtró | ✅ (con hallazgos corregidos en etapas previas, ver Etapa 6) | `assertPermission`/`assertServerOnly` en cada módulo de comandos. |
| Enmascarado de datos sensibles (`people.view_sensitive`) aplicado de forma consistente en **todos** los lugares donde se muestra DNI/email/teléfono, no solo en la grilla principal de Personas | ⚠️ → ✅ **corregido en esta etapa** | Ver hallazgos reales abajo — se encontraron y corrigieron tres rutas donde el dato sensible llegaba sin enmascarar a un rol sin el permiso. |

## 5. Hallazgos reales de esta etapa (con test de regresión)

Los tres comparten la misma causa raíz: el enmascarado de `people.view_sensitive` se estableció correctamente en la grilla y ficha de Personas (Etapa 3), pero **no se re-verificó** cada vez que una etapa posterior agregó una nueva superficie que también muestra datos de una persona. Es exactamente el riesgo que una auditoría de seguridad dedicada al final existe para atrapar — ninguno se coló hasta producción porque el proyecto nunca se desplegó, pero los tres eran bugs reales y explotables por cualquier usuario con el rol OPERADOR (que tiene `people.edit`, `associations.manage_members` y `forms.review_duplicates`, pero deliberadamente no `people.view_sensitive`).

1. **`updatePerson` no impedía cambiar DNI/email/teléfono sin `people.view_sensitive`** (`lib/people/commands.ts`). El formulario de edición de Personas mostraba y permitía editar el valor real de estos campos a cualquiera con `people.edit`, sin chequear el permiso de datos sensibles por separado. Corregido en dos capas: el servidor ahora ignora esos tres campos del `input` y conserva los valores existentes cuando el actor no tiene `people.view_sensitive` (la protección real); el formulario además deshabilita y enmascara esos campos en la UI para no confundir (`PersonForm.tsx`). Test: `tests/integration/people-commands.test.ts`, describe "sin people.view_sensitive, updatePerson ignora DNI/email/teléfono".
2. **La búsqueda de personas para sumar como miembro de una asociación mostraba el DNI en claro** (`searchPeopleToAdd`, `lib/associations/queries.ts`), gateada solo por `associations.manage_members` — un permiso que no implica `people.view_sensitive`. Corregido enmascarando en el propio query (recibe `canSeeSensitive` como parámetro), no en el componente — así el valor real nunca sale del servidor para quien no debe verlo. Test: `tests/integration/associations.test.ts`, "searchPeopleToAdd enmascara el DNI sin people.view_sensitive".
3. **La bandeja de revisión de duplicados de Formularios mostraba el payload crudo del envío** (que típicamente incluye DNI/email/teléfono tal cual los escribió quien completó el formulario), gateada solo por `forms.review_duplicates` — tampoco implica `people.view_sensitive`. Corregido devolviendo `rawPayload: null` desde `listPendingDuplicateCandidates` cuando el actor no tiene el permiso (la UI ya manejaba ese caso ocultando la sección, sin cambios necesarios ahí). Test: `tests/integration/forms.test.ts`, "sin people.view_sensitive, la bandeja de revisión no trae el payload crudo".

**Lección para etapas futuras**: cualquier pantalla nueva que muestre nombre+DNI/email/teléfono de una persona (sea la ficha principal o una vista secundaria — resultados de búsqueda, revisión de duplicados, exportaciones, lo que sea) tiene que pasar por `applyMasking`/chequear `people.view_sensitive` explícitamente. No alcanza con que "en algún lugar de la app" ya esté enmascarado.

## 6. Inyección y validación

| Ítem | Estado | Verificación |
|---|---|---|
| Sin concatenación de input de usuario en SQL | ✅ | Kysely parametriza todo por diseño; `grep` de `sql.raw(`/`sql.id(` en todo el repo: cero usos. El único `sql.ref()` (en `lib/analytics/queries.ts`) recibe siempre un nombre de columna fijo en código, nunca un valor de usuario. |
| Sin XSS vía HTML crudo | ✅ | `grep` de `dangerouslySetInnerHTML`: cero usos en toda la app. React escapa por defecto. |
| CSV/formula injection en exportaciones | ✅ | `sanitizeCsvCell` (antepone `'` a celdas que empiezan con `=`/`+`/`-`/`@`) usado en **ambos** módulos de exportación (`lib/people/export.ts`, `lib/forms/export.ts`). |
| Validación server-side con Zod en toda Server Action/endpoint público | ✅ | Zod compartido cliente/servidor (D-otras decisiones menores); la fuente de verdad de "qué es válido" nunca es solo el `required` del HTML. |

## 7. Rate limiting (D13)

Todo guardado en tabla (`login_attempts`, `public_link_attempts`), nunca en memoria de proceso — sobrevive a un restart y funciona igual con múltiples instancias del servidor. Scopes activos: login, `invitation_view`, `invitation_respond`, `checkin_qr`, `checkin_identify`, `checkin_confirm`, `invitation_checkin`, `form_submit`. Umbrales altos a propósito (cientos de personas pueden compartir la misma IP en un acto/asamblea).

## 8. Auditoría y trazabilidad (R8)

| Ítem | Estado |
|---|---|
| `audit_logs` append-only forzado por trigger de Postgres, no solo por convención | ✅ (`tests/integration/schema-guarantees.test.ts`) |
| Cada módulo de comandos sensibles escribe auditoría (creación, cambio de estado, desactivación, check-in, resolución de duplicados, etc.) | ✅ — verificado que ningún módulo de `lib/*/commands.ts`, `lib/*/members.ts`, `lib/attendance/*`, `lib/forms/duplicates.ts` tiene cero llamadas a `writeAuditLog`. Ediciones de campos/acciones de un formulario en borrador (antes de publicar) no generan una fila propia — se consideró que el evento que importa auditar es la publicación en sí, no cada tecla; es una decisión de alcance, no un olvido. |
| Ningún borrado físico de entidades con historial | ✅ | R8, `tests/integration/schema-guarantees.test.ts` + FKs `RESTRICT` documentadas en `SUTECBA_DATABASE.md` §4. |

## 9. Datos sensibles (R7)

- `person_field_definitions.sensitive` + `people.view_sensitive` es el mecanismo de software para marcar y proteger un campo como sensible (p. ej. afiliación sindical, si se llegara a cargar como campo personalizado). Ya wireado end-to-end tras el §5 de esta etapa.
- La validación **legal** de qué constituye dato sensible bajo la Ley 25.326 y qué tratamiento corresponde sigue, por diseño, fuera del alcance de esta etapa — queda para `docs/datos-personales.md` (Etapa 19), que no es una decisión de software.

## 10. Defensa en profundidad a nivel de base — RLS (decisión, no implementado)

El resumen original de la Etapa 1 (`SUTECBA_ARCHITECTURE.md` §6) preveía "RLS habilitado igual como defensa en profundidad... evita que una fuga de credencial de solo-lectura exponga todo". Al revisar esto en la práctica:

- D2 eligió conexión directa server-only con **una sola credencial** (no PostgREST/Supabase-JS con clave anon pública) — no existe en el código, ni existió nunca, una segunda credencial de "solo lectura" separada de la de lectura-escritura.
- Row Level Security en Postgres no protege nada si el rol que se conecta es el dueño de las tablas (o tiene `BYPASSRLS`), que es el caso normal de una única credencial de aplicación — haría falta además crear un segundo rol de base con privilegios reducidos y `FORCE ROW LEVEL SECURITY`, algo que hoy no tiene ningún consumidor real (no hay herramienta de BI ni conexión externa de reportes).
- **Decisión**: no se implementa RLS en esta etapa. Es complejidad real (una decisión de infraestructura de base, con superficie de error si se configura mal) para proteger un escenario que hoy no existe. Si en el futuro se agrega un consumidor externo de solo lectura (un dashboard de BI, un export automatizado con su propia credencial), ESE es el momento de crear el rol de solo lectura + políticas RLS — no antes. Se deja documentado acá para no perder el razonamiento.

## 11. Transporte y despliegue

- Cookie `secure` condicionada a `NODE_ENV === "production"` — en HTTPS real la cookie de sesión nunca viaja sin cifrar.
- Rutas públicas sensibles (`/reunion/checkin*`, `/reunion/invitacion/*`, `/f/[slug]`) marcadas `noindex, nofollow`.
- Despliegue (dominio, nginx, PM2, TLS) queda fuera de esta etapa por diseño (sección 16 del prompt) — nada de eso se toca sin pedido explícito.

## 12. Pendientes explícitos

- Nada de esto se probó contra un Postgres real, solo PGlite (pendiente heredado desde la Etapa 2).
- RLS/rol de solo lectura: descartado por ahora, ver §10.
- Validación legal de datos sensibles (R7): Etapa 19.
