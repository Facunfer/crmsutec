# Cierre de la importación de las tandas 1 y 2 (2026-09-30)

Estado: **cerrada y verificada**. Plan hash aprobado y aplicado: `dbf3d09576ab3944b8a7458060e5f48f610141fe905c747163885351fb883b61`.

## Despliegue y repositorio

| Elemento | SHA | Nota |
|---|---|---|
| Producción (VPS) desplegada | `2377dae` | migraciones 0031–0033 + compatibilidad de código + importador |
| `origin/master` | `a016b60` | suma un solo commit: optimización del importador |

La diferencia `2377dae..a016b60` es únicamente la optimización del importador de procedencia (`lib/imports/tandas/apply.ts`: un `UPDATE` de `import_rows` por bloque en lugar de uno por fila). **No afecta el runtime de la aplicación** ni el plan/hash. No hace falta redeploy ahora; el próximo deploy lo incorporará.

## Resultado (producción, conciliado contra el dry-run)

- 177.436 altas (176.681 con nombre sin separar: `name_split_status = 'unsplit'`); 179.631 personas en total.
- 3.500 participaciones `participated` + `source_business_rule`; 49 inscripciones (52016); 1.120 participaciones legacy intactas.
- 0 `person_interactions` nuevas (1.120 en total) y 0 asistencias.
- 6 reuniones nuevas (propietaria SUTECBA raíz); 3 claves de campaña nuevas.
- Etiqueta `abogado` a 175.162 personas y 175.162 observaciones `colegio_votacion`.
- 46 organizaciones completadas (resolución inequívoca); 177.238 personas quedan sin organización (no se infirió ninguna).
- 244 identidades bloqueadas sin enriquecimiento; 5.401 filas LE/LC/CI excluidas; 5.837 incidencias registradas.
- Segunda corrida: `noop_idempotent`, 0 escrituras, estado idéntico.

## Fuera de esta fase

- Los 216 conflictos de identidad vinculados a un posible corrimiento de filas de `abogados unificado.xlsx` (reporte privado en `Documents\sutecba-fuentes\reports\tandas-dry-run\`): no se tocaron identidades, participaciones ni datos relacionados.
- Bloque II (permisos, scopes, performance, etc.).

## Respaldos previos

Backup lógico (`backup:logical`, 49 tablas) y `pg_dump` 17.6 (`backups\supabase-pre-tandas-…`), ambos restaurados con éxito en entornos locales aislados; ensayo completo del apply sobre la copia restaurada coincidió con el dry-run.
