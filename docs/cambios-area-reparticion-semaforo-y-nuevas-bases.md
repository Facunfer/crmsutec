# Área/Repartición, semáforo, participantes, retiro de módulos y nuevas bases (2026-09-21)

Actualización 2026-09-22: producción tiene migraciones **0001..0027**, el primer lote histórico y las correcciones de nacimiento verificadas. **0028, reconciliación histórica, catálogo adicional y segundo lote siguen pendientes**. Las correcciones del runner, hash, procedencia y presentación se validan localmente; ver [estado actualizado](correcciones-previas-produccion.md).

## 1. Migraciones nuevas (posteriores a 0023; las ya aplicadas no se tocaron)

| Migración | Tipo | Contenido |
|---|---|---|
| `0024_area_reparticion_and_participation_interactions.sql` | aditiva | `users.primary_organization_id`; función `organization_area_id(uuid)`; `person_interactions.occurred_precision` + `source_key` (índice único parcial) + índice de última interacción; tipo de interacción `participation`. |
| `0025_drop_audit_logs_and_retired_permissions.sql` | **DESTRUCTIVA** | Elimina `audit_logs` (+ sus triggers, política y función) y los permisos `audit.view`, `roles.manage`, `people.manage_custom_fields`. |

El siguiente procedimiento es la referencia histórica de 0025, ya aplicada. El runner conserva el requisito `--allow-destructive` para migraciones destructivas pendientes:

1. `npm run audit:export-before-drop -- --out "C:\Users\usuario\Documents\sutecba-fuentes\backups\audit_logs.json"` (solo lectura; fuera de Git).
2. Backup vigente confirmado.
3. `npm run migrate -- --yes --allow-destructive`.

## 2. Área y Repartición

`people.organization_id` sigue siendo la unidad más específica. **Área = ancestro raíz** (la unidad sin padre a la que se llega por `parent_id`); **Repartición = la unidad** (vacía si la unidad guardada es el Área). SUTECBA (tipo `sindicato`) nunca es Área ni Repartición laboral (validado en alta, traslado y asignación). Definición única: `organization_area_id()`.

Usuarios: `users.primary_organization_id` es la **afiliación** (informativa). Lo que el usuario ve lo definen solo los `user_scopes`.

## 3. Semáforo y KPIs

Se calculan siempre desde la última interacción válida (`open`/`completed`, no futura, dentro del alcance): verde 0–30 días, amarillo 31–60, rojo >60, gris nunca. Los KPIs cuentan personas, respetan alcance y filtros, y cada uno es un enlace que activa el filtro.

## 4. Interacción automática por participación

`lib/interactions/participation-sync.ts`: `attended` con evidencia, o exclusivamente para la carga histórica inicial `participated` + `legacy_initial_import`, siempre con jornada y fecha utilizable; también check-in real no corregido a «ausente». La inscripción estándar, la invitación y la confirmación no generan interacción. Los importadores y el reconciliador histórico sincronizan únicamente sus participaciones. `source_key` hace idempotente la creación y `date_only` conserva la precisión. El CHECK valida estado/base; la procedencia la valida el reconciliador mediante los enlaces de importación.

## 5. Reuniones de SUTECBA vistas por un área

Regla de lectura (`meetingVisibility`): propietaria en el alcance **o** con participantes (participación, invitación vigente o check-in) del alcance. Solo lectura: operar sigue exigiendo el alcance propietario. Conteos y participantes se limitan a las personas del alcance. Las participaciones de campaña sin jornada probada se muestran aparte («Sin jornada asignada»).

## 6. Defecto encontrado: fechas sin hora un día antes

El primer import escribió `birth_date` y `meetings.event_date` con un `Date` (el driver `pg` lo serializa en hora local). En producción quedaron **685 fechas de nacimiento y 22 de reuniones un día antes**. El código ya usa `lib/db/date-only.ts` (`'AAAA-MM-DD'::date`). La corrección de lo importado es dirigida y verificada contra la fuente: `npm run import:fix-dates` (dry-run) / `--apply --created-by <UUID> --expect-people 685 --expect-meetings 22 --yes`. **Aplicarla antes de generar interacciones desde reuniones `date_only`.**

## 7. Usuario de prueba de Cultura (no creado en producción)

`npm run user:create-scoped -- --email cultura.test@sutecba.local --name "Usuario de prueba Cultura" --area-code MCGC --credentials-file "C:\Users\usuario\Documents\sutecba-fuentes\credentials\usuario_cultura.txt"` (dry-run). Con `--apply --created-by <UUID> --yes`: rol ADMIN, alcance MCGC + descendientes, sin acceso global, contraseña temporal fuerte solo en el archivo (nunca se imprime).

## 8. Nuevas bases (2026-09-21)

Existe implementación de apply transaccional y simulación completa del segundo lote, todavía sin ejecutar en producción. Se esperan 184 personas, 208 participaciones nuevas y 563 reutilizadas; 2 identidades siguen bloqueadas. El catálogo adicional tiene 10 organizaciones y 40 alias aprobados. El CUIL incompleto de PG no se completa y F03 sigue `PENDING_CLASSIFICATION`.
