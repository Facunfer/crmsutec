# Performance de /personas — optimizaciones pendientes (registro)

Fase 1 (etapas 1 y 2, migraciones 0034–0035 y consulta «IDs primero») implementada y probada; ver `db/migrations/0034_people_list_performance.sql`, `0035_people_search_trigram.sql` y `tests/integration/people-list-optimization.test.ts`. Lo siguiente **no** forma parte de esa fase y queda registrado:

## Pendientes (no implementados a propósito)

1. **Paginación por cursor (keyset).** Con filtro de etiqueta masiva (`abogado`, 175.162 personas) una página muy profunda (p. ej. 2.000) tarda ~1,3–1,5 s porque el planner recorre el índice por nombre probando la etiqueta fila por fila. Sin filtro la misma página es instantánea. Requiere cambiar la UX/URL de paginación (decisión de Bloque II).
2. **Limpieza de índices sin uso o redundantes** (no se borró ninguno): `people_phone_idx`, `people_cuil_cuit_idx`, `people_email_idx` (es `lower(email)`; la búsqueda usa `email ILIKE`) y `people_custom_fields_gin_idx` (0 escaneos); `person_interactions_person_valid_actual_idx`, `_responsible_idx`, `_followup_idx` (0); `person_tags_person_active_idx` (7,6 MB, redundante con `person_tags_active_unique_idx`); `person_observations_person_idx` (13 MB, redundante con `person_observations_unique`); `tags_owner_active_idx` (0). Decidir con estadísticas de uso más largas.
3. **Conteo con filtro de etiqueta masiva** (~236 ms, `Merge Semi Join` sobre 175.162 filas): por encima de los 180 ms orientativos. Evaluar un contador precomputado solo si molesta.
4. **Búsqueda de 1–2 caracteres:** no usa trigram (~220–240 ms; mejoró desde 1.614 ms). Aceptado.
5. **Exportación en streaming:** hoy carga las 179.631 filas en memoria y arma el CSV completo; la ejecución en la base mide ~0,6 s, el resto es transferencia y armado.
6. **«Última interacción» → «último contacto real»:** esta fase conserva la regla vigente; el cambio de semántica corresponde a una fase posterior.
7. **`CREATE INDEX` sin `CONCURRENTLY`:** el runner de migraciones usa transacción; ambos scripts bloquean escrituras en `people` unos segundos (medido en una restauración del backup de producción: 0034 ≈ 0,9 s, 0035 ≈ 2,4 s) y fijan `lock_timeout = 10s` para fallar rápido en lugar de bloquear a la aplicación.
