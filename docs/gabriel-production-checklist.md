# Checklist histórico — primer `import:gabriel --apply` (ya ejecutado)

**Estado al 2026-09-22:** el primer lote ya está importado: 2.011 personas, 25 reuniones y 912 participaciones originales. Producción tiene 0001..0027; 0028 está preparada y pendiente. Este checklist conserva el procedimiento del primer lote y NO debe ejecutarse como una nueva carga. La reconciliación histórica, el catálogo adicional (+10 organizaciones/+40 alias) y el segundo lote siguen pendientes en producción. Ver [estado de las correcciones locales](correcciones-previas-produccion.md).

Procedimiento para el día del apply. **No incluye secretos**: las conexiones salen del `.env` del servidor (`SUTECBA_DATABASE_URL` = `sutecba_app`, `SUTECBA_MIGRATION_DATABASE_URL` = `postgres`), nunca se pegan en comandos ni en este documento.
Regla del proceso: **ante cualquier diferencia, ABORTAR** y no seguir al paso siguiente.

## 0. Antes del día (decisiones que no puede tomar el script)

- [x] Las 14 identidades bloqueadas decididas (`gabriel_identidades_bloqueadas_DECISIONES_APROBADAS.xlsx`: 11 `MERGE_SAME_PERSON`, 1 `KEEP_BLOCKED`, 2 `REVIEW_LATER`) e incorporadas al plan. Todos los comandos (dry-run, simulación y apply) llevan `--identity-decisions <json> --identity-decisions-xlsx <xlsx>`; el JSON sale de `python tools/identity-decisions-extract.py <xlsx> <json>` (fuera de Git). Sin las decisiones el `plan_hash` es otro y el apply aborta.
- [ ] F03: decisión sobre el curso (`gabriel_f03_revision.xlsx`). Mientras no se decida, F03 no crea reuniones ni participaciones.
- [ ] Unidad propietaria del lote y de las reuniones: la organización raíz **SUTECBA** (`official_code = SUTECBA`, tipo `sindicato`, sin padre; creada con `npm run org:owner`). Su UUID es el `--owner-organization-id`; `npm run import:gabriel -- --simulate-apply --owner-official-code SUTECBA` lo resuelve y verifica (existe, activa, raíz, nada cuelga de ella).
- [ ] Usuario ejecutor `--created-by`: MASTER_GLOBAL activo con permiso `imports.run`.
- [ ] Ventana de mantenimiento acordada (nadie usando el CRM).
- [ ] Interpretar los números así (no son métricas que se suman a ciegas): **identidades canónicas totales = INSERT reales de `people` en este apply + personas bloqueadas**. Las filas sin DNI no son identidades. El resultado del apply informa `people_insert_reales`.
- [ ] Números esperados anotados (ver «Validación de conteos»). Referencia con las decisiones aprobadas (`plan_hash c7b31923…`): 2.014 identidades canónicas = 2.011 INSERT reales de `people` + 3 bloqueadas; 25 reuniones; 912 participaciones; 0 asistencias. (Sin decisiones: `af809944…`, 2.000 + 14.)

## 1. Backup

- [ ] Para una futura intervención, confirmar un backup posterior a 0027 y a la carga histórica existente, y anotar su fecha y hora. No usar un backup previo al primer lote como punto de partida.
- [ ] Opcional pero recomendado: volcado lógico solo de esquema y catálogos con la conexión de migración, guardado **fuera de Git** (`pg_dump --schema-only` y, de datos, `organizations`, `organization_types`, `organization_aliases`, `roles`, `role_permissions`, `users`).
- [ ] Anotar el conteo previo: `people = 0`, `meetings = 0`, `meeting_participations = 0`, `import_batches = 0`, `import_rows = 0`, `import_files = 0`.

## 2. Preflight (solo lectura)

- [ ] `SUTECBA_ENV=production`.
- [ ] Runtime conectado como `sutecba_app` (sin superusuario ni BYPASSRLS); migración como `postgres`.
- [ ] `sutecba_meta.system = 'sutecba-crm'`; base = la de SUTECBA (nunca los proyectos bloqueados).
- [x] Estado auditado: `0001` … `0027` aplicadas; `0028` pendiente. No aplicar 0028 durante la fase de correcciones locales.
- [ ] Catálogo organizacional cargado: 147 organizaciones (146 GCBA + la raíz SUTECBA), 160 alias aprobados (129 globales, incluidos los 2 aprobados por decisión humana, + 31 contextuales); `organization_aliases` sin sombras.
- [ ] Ningún proceso de la aplicación escribiendo (ver paso 5) y ninguna otra sesión `sutecba_app` activa.
- [ ] Simulación de solo lectura con la base real y comparación con los números esperados:

```bash
npm run import:gabriel -- --simulate-apply --raw-dir "C:\Users\usuario\Documents\sutecba-fuentes\raw"
```

## 3. Hashes de los 10 originales

- [ ] Los originales están en `Documents\sutecba-fuentes\raw\` (fuera de Git) y **no cambiaron desde la extracción**. El comando de los pasos 2 y 6 con `--raw-dir` recalcula el SHA-256 de cada original y lo compara con el del extracto; cualquier diferencia aborta.
- [ ] Los 10 códigos F01–F10 presentes, sin repetidos ni faltantes (también lo verifica el importador).
- [ ] Si hubo que volver a extraer: `python tools/gabriel-extract.py <raw> data/gabriel/extracted` y repetir el dry-run desde el paso 2.

## 4. `plan_hash`

- [ ] Correr el dry-run y anotar el hash:

```bash
npm run import:gabriel -- --raw-dir "C:\Users\usuario\Documents\sutecba-fuentes\raw"
```

- [ ] El `plan_hash` impreso es **el aprobado por SUTECBA** (el que figura en el acta de aprobación). Si es otro, ABORTAR y reportar el nuevo hash: cambió un archivo, una regla o una decisión.

## 5. Detener la aplicación

- [ ] Detener `npm run dev` / el servicio del CRM (`systemctl stop …` o `pm2 stop …`, según el despliegue) y confirmar que no queda ningún proceso Node del CRM.
- [ ] Verificar en la base que no hay sesiones `sutecba_app` activas escribiendo (`pg_stat_activity`, estado `active`).

## 6. Ejecutar el apply

```bash
npm run import:gabriel -- --apply --confirm-plan <PLAN_HASH_APROBADO> --owner-organization-id <UUID_UNIDAD_PROPIETARIA> --created-by <UUID_USUARIO_MASTER> --raw-dir "C:\Users\usuario\Documents\sutecba-fuentes\raw" --yes
```

Qué hace el comando (todo o nada): verifica entorno, rol `sutecba_app`, identidad de la base, migraciones, actor y unidad; recalcula el `plan_hash`; verifica los SHA-256 de los originales; toma el lock transaccional; escribe en **una** transacción (archivos, lote, filas de staging, incidencias, personas, reuniones, participaciones, auditoría). Nunca imprime DNI, CUIL, emails, teléfonos ni nombres.

- [ ] Resultado esperado: `resultado: applied`, `rol_de_escritura: sutecba_app`, resumen sin datos personales.
- [ ] Si imprime `ABORTADO` o `error`: **no se escribió nada** (rollback total). Ir al paso 12.

## 7. Validar conteos

Comparar contra el resumen del apply y contra los números esperados (solo lectura):

- [ ] `people` = INSERT reales esperados (hoy 2.011, informado como `people_insert_reales`); todas con `origin = 'import'`.
- [ ] `people.organization_id`: con organización = esperadas (hoy 1.244); `NULL` = el resto (hoy 767).
- [ ] `meetings` = esperadas (hoy 25: 1 con horario exacto, 22 `date_only`, 2 `unknown`); ninguna con hora inventada.
- [ ] `meeting_participations` = esperadas (hoy 912); **ninguna** `attended`; `meeting_attendance` = 0.
- [ ] `import_batches`: 1 lote `applied` con `execution_mode = 'apply'`, `plan_hash` correcto, `applied_at` y `summary`.
- [ ] `import_files` = 10; `import_rows` = filas fuente (hoy 3.197); `import_issues` = incidencias (hoy 554).
- [ ] Las 3 identidades que siguen bloqueadas (1 `KEEP_BLOCKED`, 2 `REVIEW_LATER`) **no** existen en `people` y sus filas quedan `in_review`.
- [ ] `audit_logs`: una entrada `IMPORT_APPLIED` con el actor.

## 8. Validar duplicados

- [ ] Un solo `people` vigente por DNI (`select dni, count(*) from people where status <> 'merged' group by 1 having count(*) > 1` → 0 filas).
- [ ] Sin `source_event_key` repetido en `meetings`.
- [ ] Sin participaciones repetidas por (reunión o campaña, persona, tipo).
- [ ] **Idempotencia** (opcional, recomendable): repetir el mismo comando de apply; debe dar `noop_idempotent` con 0 personas / reuniones / participaciones nuevas.

## 9. Validar organizations y scopes

- [ ] `organizations` sigue en 147; `organization_aliases` en 160; ninguna organización creada por el importador.
- [ ] Ninguna persona apunta a una organización inexistente o inactiva.
- [ ] Un usuario MASTER_GLOBAL ve las 2.011 personas; un usuario con alcance limitado ve solo las de su unidad (y dependientes si `include_descendants`); las personas con `organization_id NULL` solo las ve MASTER_GLOBAL.
- [ ] Las personas resueltas por contexto quedan en la unidad más específica (p. ej. DGTAL del Padrón PG → `DGTALPG`).
- [ ] Las personas con `dni_source = 'derived_from_cuil'` conservan su `cuil_cuit` y coinciden con él.

## 10. Smoke test

- [ ] Levantar la aplicación.
- [ ] `/login` responde 200; una ruta protegida sin sesión redirige a `/login`.
- [ ] Login del MASTER_GLOBAL; abrir `/personas` (lista, búsqueda por DNI, una ficha), `/reuniones` (una `date_only` muestra solo el día, sin hora) y un formulario público.
- [ ] Sin errores SQL en el log de arranque.

## 11. Reiniciar la aplicación

- [ ] Servicio arriba y estable (sin errores en los primeros minutos); avisar el fin de la ventana.
- [ ] Guardar el resumen del apply y el `batch_id` en el acta (sin datos personales).

## 12. Si algo falla

| Situación | Acción |
|---|---|
| Falla un chequeo **antes** de escribir (pasos 2–5) o el comando aborta | No se escribió nada. Corregir la causa, repetir el preflight; si cambió algún archivo o regla, regenerar y re-aprobar el `plan_hash`. |
| El apply falla a mitad | Todo se revierte solo (una transacción). Confirmar los conteos previos (paso 1) y reportar el mensaje (viene sin datos personales). No reintentar sin entender la causa. |
| El apply terminó pero un conteo/duplicado/scope no coincide | **No borrar filas a mano** (no hay borrados destructivos). Dejar la aplicación detenida, reportar el desvío y decidir entre: (a) restaurar al punto de restauración anotado en el paso 1 (Supabase) y repetir el proceso, o (b) corrección dirigida por migración/comando revisado. |
| El smoke test falla por el importador | Dejar la aplicación detenida, restaurar el backup del paso 1 si el problema son datos importados, y reportar. |
| Un dato de una persona es incorrecto | Se corrige por la interfaz/comandos normales (queda auditado), no editando la base. |

Después del apply, mantener `SUTECBA_ENV=production` y **no** volver a correr el apply con otro `plan_hash` sin repetir este checklist.
