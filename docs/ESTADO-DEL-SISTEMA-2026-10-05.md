# SUTECBA CRM — el sistema y dónde estamos (2026-10-05)

Documento de situación. Resume qué es el sistema, cómo está armado, qué se hizo en las últimas semanas, en qué estado está producción hoy y qué falta. Para detalle técnico ver también `SUTECBA_ARCHITECTURE.md`, `SUTECBA_DATABASE.md`, `SUTECBA_DESPLIEGUE.md`, `SUTECBA_SEGURIDAD.md` y los documentos de `docs/`.

---

## 1. Qué es

CRM del sindicato SUTECBA para gestionar **personas** (afiliadas o no), las **organizaciones** del Estado de la Ciudad donde trabajan, y todo lo que se hace con ellas: **reuniones y capacitaciones**, **campañas** (vacunación, oftalmología), **formularios públicos**, **interacciones** (contactos) y **etiquetas**. Está pensado para que cada usuario vea solo lo que le corresponde según su área (alcance).

## 2. Cómo está armado

| Capa | Tecnología |
|---|---|
| Aplicación | Next.js 15 (App Router, TypeScript), React, AG Grid para las grillas, Zod para validar |
| Acceso a datos | Kysely sobre PostgreSQL (consultas SQL explícitas) |
| Base de datos | PostgreSQL 17 en Supabase (esquema `public`); dos roles: `sutecba_app` (runtime, con RLS) y `postgres` (solo migraciones) |
| Tests | Vitest; la base de tests es PGlite (PostgreSQL embebido) con las mismas migraciones |
| Servidor | VPS Hostinger (`/opt/sutecba`), proceso `pm2` llamado `sutecba`, HTTPS autofirmado |
| Despliegue | `git pull` → `npm run build` → `pm2 restart sutecba` (lo hace una persona desde la consola web del VPS) |

Repositorio: `Facunfer/crmsutec`, rama `master`.

### Conceptos centrales del modelo

- **Persona** (`people`): el identificador canónico es el **DNI** (solo dígitos, 7–8, único entre personas no fusionadas). CUIL/CUIT es un dato aparte. Hay personas con **nombre sin separar** (`name_split_status = 'unsplit'`): se conserva el texto original completo en `last_name` (y en `full_name_original`) y `first_name` queda vacío; nunca se separa por heurística.
- **Organizaciones** (`organizations`): árbol (Área = raíz; Repartición = unidad). Las personas pueden no tener organización (`organization_id = NULL`); eso es válido y se respeta.
- **Alcance (scopes)**: cada usuario ve las personas cuya organización está dentro de su alcance. **Master global** ve todo. Una persona sin organización **no** aparece para un usuario de área.
- **Actividades**: `meetings` (reuniones/capacitaciones/jornadas, con `source_event_key`) y **campañas** (`campaign_key`, p. ej. `ophthalmology:<organismo>`, `vaccination:2026`). La participación (`meeting_participations`) distingue **inscripción**, **asistencia** (check-in real) y **participación acreditada por una fuente** (`participated`).
- **Base de la participación** (`participation_basis`): `standard` (flujo normal), `legacy_initial_import` (decisión exclusiva de la primera carga histórica) y `source_business_rule` (participación acreditada por una fuente y una regla de negocio explícita; **no** genera interacciones).
- **Interacciones** (`person_interactions`): contactos reales. Alimentan el **semáforo** (verde ≤30 días, amarillo 31–60, rojo >60, gris nunca). La importación **no** crea interacciones ni asistencia.
- **Etiquetas** (`tags`, `person_tags`) y **observaciones** (`person_observations`: categoría + valor + procedencia, inmutable; p. ej. `colegio_votacion`).
- **Trazabilidad de importaciones**: `import_batches` → `import_files` (hash) → `import_rows` (fila original) → `import_entity_links` (a qué entidad dio lugar) + `import_issues`.

## 3. Qué se hizo (resumen cronológico)

1. **Cargas históricas** (septiembre): primer lote de Gabriel (≈2.000 personas, reuniones históricas) y segundo lote (oftalmología + Padrón PG), con migraciones hasta 0030.
2. **Tandas 1 y 2 (2026-09-30)**: 22 fuentes (vacunación, oftalmología, capacitaciones, listados de cursada, padrón PG y padrón de abogados). Antes se agregaron las migraciones 0031–0033 (base `source_business_rule`, nombre sin separar, observaciones). Resultado conciliado contra el dry-run y con segunda corrida idempotente (`noop_idempotent`). Detalle en `docs/importacion-tandas-1-2-cierre.md`.
3. **Optimización de `/personas` (octubre)**: el listado tardaba ~4–5 s con 179.631 personas. Migraciones 0034 (función `organization_area_id` STRICT + índice por nombre) y 0035 (5 índices trigram para la búsqueda) y reescritura de las consultas ("IDs primero", conteo y KPIs sin sondeo por persona). Resultado medido en producción: listado ~0,2–0,3 s, búsquedas ~0,16 s, gris 0,26 s (tiempos desde afuera, incluyen la red). Registro de pendientes en `docs/pendientes-performance-personas.md`.
4. **Etiquetas en la interfaz (octubre)**: la etiqueta `abogado` y el colegio de votación existían en la base pero no se veían. Se agregó el filtro "Etiqueta" en `/personas` (y en la exportación), una columna "Etiquetas" y, en la ficha, las etiquetas y las observaciones.

## 4. Estado de producción (última verificación)

| Dato | Valor |
|---|---|
| Migraciones aplicadas | 35 (última: `0035_people_search_trigram.sql`) |
| Personas | 179.631 (176.681 con nombre sin separar; 177.238 sin organización) |
| Etiqueta `abogado` | 175.162 personas, con observación `colegio_votacion` |
| Participaciones | 5.581 (3.500 `source_business_rule`, 1.120 legacy, 961 estándar) |
| Interacciones | 1.120 (la importación no creó ninguna) |
| Asistencias | 0 |
| Reuniones | 36 (todas con propietaria SUTECBA raíz) |
| Lotes de importación aplicados | 4 |

Código: `origin/master` en `2ba1979` (filtro de etiquetas). Producción corría `b566bad` (optimización) al momento de la última verificación; el deploy de `2ba1979` queda a cargo de quien opera la VPS (`git pull`, `npm run build`, `pm2 restart sutecba`).

## 5. Qué hay que saber (decisiones y límites vigentes)

- **Personas sin organización**: 177.238. Un usuario de área **no** las ve; solo Master. No se inventó ninguna organización (ni "colegio" ni "abogado" son organizaciones). Cómo trabajarlas con permisos de área es una decisión futura.
- **Nombres sin separar**: 176.681 personas (padrón de abogados y formulario Antigripal). Se editan cargando nombre y apellido por separado; recién ahí pasan a `split` conservando el original.
- **244 identidades bloqueadas** en la carga de tandas (216 con conflicto de nombre contra personas ya cargadas, 28 entre filas de la misma carga) **sin enriquecimiento** (no se les agregó etiqueta, colegio ni participaciones). 5.401 filas LE/LC/CI del padrón quedaron fuera (tipo documental no soportado).
- **Posible corrimiento en `abogados unificado.xlsx`**: en 117 de los casos analizados el nombre de la base coincide con el DNI de la fila anterior de esa fuente (diferencia constante de −1 fila). Es una **revisión pendiente y separada**; no se corrigió ni fusionó nada. El reporte detallado (con datos personales) está en `Documents\sutecba-fuentes\reports\tandas-dry-run\` y **no** se versiona.
- **Fechas**: las actividades sin fecha acreditada quedan con fecha desconocida; nunca se usa el timestamp del formulario como fecha de la actividad.
- **Datos personales**: los archivos fuente, volcados, backups y reportes con DNI **no se versionan** (viven en `Documents\sutecba-fuentes\`).

## 6. Procedimientos operativos probados

- **Backups** (antes de cualquier cambio en producción): `npm run backup:logical` (lógico, 50 tablas, verificado por hash) y `scripts/backup-pgdump.cjs` (`pg_dump` 17.6: esquema, datos, completo y roles). Ambos se restauraron con éxito en entornos locales aislados (`scripts/restore-logical-backup.ts` y PostgreSQL local). **No hay backup gestionado de Supabase/PITR confirmado**; ese riesgo fue aceptado explícitamente.
- **Migraciones**: `npm run migrate -- --yes` aplica todas las pendientes de una vez. Para aplicar de a una se usó un aplicador temporal (no versionado) que rechaza saltear el orden.
- **Importaciones**: dry-run de solo lectura → aprobación explícita con el hash del plan → apply por fases idempotentes y reanudable → conciliación → segunda corrida. Scripts en `scripts/` (`import-tandas-dry-run.ts`, `apply-tandas.ts`, `preflight-tandas.ts`).
- **Despliegue**: ver `SUTECBA_DESPLIEGUE.md`; en el VPS, `/opt/sutecba`.

## 7. Pendientes y próximos pasos

**Optimización de Personas (registrados, no implementados)**
1. Paginación por cursor (keyset): con la etiqueta `abogado` una página muy profunda aún tarda ~1,3 s.
2. Limpieza de índices sin uso o redundantes (lista en `docs/pendientes-performance-personas.md`).
3. Conteo con etiqueta masiva (~236 ms), exportación en streaming.

**Datos**
4. Revisión específica de las 216 identidades y del posible corrimiento de `abogados unificado.xlsx`.
5. Decidir qué hacer con los textos de organismo sin alias aprobado (p. ej. `salud bolivar`, `legislatura`, `same`): hoy 2.092 personas nuevas y 162 existentes quedan sin organización por eso.
6. Existe una persona histórica con textos de reemplazo (`(sin nombre)`/`(sin apellido)`), anterior a la migración 0032; no se tocó.

**Producto (Bloque II, aún no iniciado salvo Personas)**
7. Rediseño de permisos/scopes (capacidad para trabajar personas sin organización).
8. Reuniones y capacitaciones, contacto (taxonomía de interacciones y futuro "último contacto real"), formularios y experiencia móvil.
9. Confirmar con prueba visual en el navegador: ficha de una persona `unsplit`, formulario de edición y el nuevo filtro de etiqueta.

## 8. Riesgos a tener presentes

- Con 179.631 personas casi todas sin organización, **los KPIs globales del Master** (total de personas, semáforo gris) cambiaron de escala; los usuarios de área no ven esas personas.
- Los `CREATE INDEX` de las migraciones nuevas bloquean escrituras en `people` unos segundos (se usó `lock_timeout = 10s`).
- Sin PITR de Supabase, la recuperación depende de los backups manuales descritos arriba.
- El runner de migraciones aplica todo lo pendiente junto: cualquier migración nueva debe pasar por backup + ensayo previo.
