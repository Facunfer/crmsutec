# Correcciones locales previas a producción — 2026-09-22

Esta fase no autoriza escrituras remotas. No se aplicaron migraciones, reconciliación, catálogo ni segundo lote en Supabase. No se hizo commit ni push. Los cambios locales previos se conservan.

## Migraciones

Producción permanece en 0001..0027. El contenido de esas migraciones no se modifica. 0028 permanece preparada.

El runner valida `--yes` antes de abrir la base o crear objetos. Separa sentencias respetando comentarios, cadenas y cuerpos dollar-quoted; retira únicamente un par exterior BEGIN/COMMIT y rechaza controles transaccionales interiores. Kysely abre una transacción, toma un lock y ejecuta SQL y ledger en la misma conexión. El driver hace el único commit. Una falla de SQL, ledger o commit revierte ambos. `--allow-destructive` sigue siendo obligatorio. Las transacciones son por migración: las anteriores confirmadas no se revierten si falla una posterior.

## Hash y procedencia

El plan `gabriel-nuevas-plan-v3` usa `organizationKey` basado en código oficial. El UUID se resuelve al aplicar, sin entrar al hash. Hash verificado con SELECT de producción y en PGlite antes/después de materializar el catálogo:

`050e51823b6e781ad9336c007290fabfef18374d876836e8ce697c26c0ea6011`

Catálogo: `a8c410a0f5192d12bbc97c90714f8c379cc75ca22cf058aeb0eb5f4a39a93f6c`.

El hash anterior del segundo lote queda obsoleto por la nueva representación canónica. No es autorización para ejecutarlo.

El segundo lote registra archivos, filas, enlace a persona y enlace a participación para las 563 participaciones reutilizadas y las 208 nuevas. Las nuevas guardan también `import_row_id`. Las filas repetidas conservan sus propios enlaces, sin duplicar la participación.

## Regla histórica y presentación

Solo la carga histórica inicial considera participación la inclusión en sus bases. El reconciliador exige procedencia `gabriel-historical` aplicada mediante batch → archivo → fila → enlace; conserva la registration original. La sincronización final se limita a los IDs del lote y no procesa asistencias ajenas.

Reuniones y ficha Persona muestran el estado efectivo una vez por persona/destino. `participated` recibe fecha solo si existe jornada con fecha válida. Las campañas muestran «Participó — jornada no determinada», sin fecha. La tasa de asistencia de la ficha excluye estas participaciones y utiliza invitaciones con resultado conocido. Exportación de personas, dashboard y KPIs cuentan personas y mantienen sus scopes; las campañas no se asignan artificialmente a jornadas.

La proyección y la consulta operativa comparten timezone Buenos Aires, interacción válida (`open`/`completed`, no futura), días calendario y buckets 0–30/31–60/>60/sin interacción. Las fechas futuras se excluyen antes de elegir la última. Una interacción anulada no se proyecta de nuevo como válida.

## Datos y límites

Histórico: 912 participaciones originales, 782 personas, 8 destinos, 107 con jornada, 805 sin jornada y 56 interacciones posibles. Proyección verificada al 2026-09-22: 56 verdes, 0 amarillos, 0 rojos, 726 grises. La reconciliación agrega filas participated conservando las 912 originales; los contadores efectivos no deben sumar ambas.

Segundo lote: 184 personas, 2 identidades bloqueadas, 208 participaciones nuevas (54 con jornada/154 sin jornada), 563 reutilizadas, 54 interacciones y ninguna asistencia inventada. F03 y el CUIL incompleto de PG continúan pendientes.

Los reportes técnicos no incluyen DNI ni nombres de personas; los archivos de revisión privados y staging conservan la información necesaria bajo sus permisos. PGlite verifica transacciones y consultas, pero no reproduce los privilegios/RLS de Supabase. Antes de una intervención productiva separada deben revisarse snapshot, permisos, hash y conteos vigentes. Los colores dependen de la fecha de consulta; no son una propiedad fija del lote.

## Verificación final

Suite completa `vitest run --no-cache`, con los archivos privados habilitados por las variables de ambas simulaciones: **671 passed, 0 skipped, 0 failed; 60 archivos; 554,66 segundos**. Incluye migraciones 0001..0028, seed, histórico, reconciliación, catálogo ampliado, segundo lote, rollback e idempotencia. Siete pruebas cubren la atomicidad y las guardas del runner; las pruebas de Cultura cubren listado, contador, campañas, ficha, exportación, dashboard y KPIs. Typecheck sin emisión limpio.

La última comprobación de Supabase fue una transacción `READ ONLY`, con `default_transaction_read_only=on`: 27 migraciones (última 0027), 2.011 personas, 25 reuniones, 912 participaciones, 0 interacciones, 0 asistencias, 147 organizaciones, 160 alias, 0 batches del segundo lote y 0 nacimientos anteriores a 1900 o futuros. El rol de aplicación no puede leer el ledger; esa comprobación usó la conexión administrativa igualmente forzada a solo lectura.

Pendientes productivos: 0028, reconciliación histórica, catálogo adicional y segundo lote. El apply del segundo lote está implementado en `lib/imports/gabriel/nuevas-apply.ts`; `npm run import:nuevas` continúa siendo el CLI de dry-run. Estas comprobaciones no ejecutan ni autorizan una carga productiva.
