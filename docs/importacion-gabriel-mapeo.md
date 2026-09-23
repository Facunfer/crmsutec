# Importación histórica de Gabriel — mapeo verificado contra los originales

> Sin datos personales: solo estructura, formas de columna y conteos. Los originales viven **fuera de Git** en `C:\Users\usuario\Documents\sutecba-fuentes\raw\` (10 archivos). Complementa `GABRIEL_IMPORT_MAP.md` (reglas de negocio). Estado: **perfilado hecho, importador sin escribir**; las columnas de F06 marcadas *(inferido)* deben confirmarse antes de fijarlas en el código.

## 1. Inventario verificado

| ID | Archivo | Hojas / estructura | Filas de datos (medidas) | Spec |
|---|---|---|---:|---:|
| F01 | R.C.P -Cruz Malta (Respuestas).pdf | 1 página, 1 tabla de 12 columnas con encabezado | 50 | 50 |
| F02 | 52010-RCP CRUZ MALTA.xlsx | `Listado alumnos` (bloque de título en filas 1–8, datos desde la 9) + `Hoja 2` (vacía) | 81 | 81 |
| F03 | AGC-CAPACITACION 2026 (Respuestas).pdf | 1 página, misma tabla de 12 columnas | 30 | 30 |
| F04 | A.G.C - Primeros auxilio psicologicos (Respuestas).xlsx | `Respuestas de formulario 1`, con encabezado | 17 | 17 |
| F05 | 52469-INTELIGENCIA EMOCIONAL EN LA ORGANIZACION - A.G.C.xlsx | `Listado alumnos` (mismo formato que F02) + `Hoja 2` vacía | 39 | 39 |
| F06 | Padron Gral x Repart.xlsx | 5 hojas **sin encabezado**: Cruz Malta 220, ASI 121, Educación 32, Teatro Colón 230, Ed. Canale 188 | 791 | 791 |
| F07 | Padrón PG.xls (OLE2 real, requiere `xlrd`) | 1 hoja `Resultados Buda`, con encabezado | 722 | 722 |
| F08 | OFTALMO 2026.xlsx | `Hoja1`: agenda, 22 jornadas con fecha | 22 | (jornadas) |
| F09 | Oftalmo Teatro Colón (Respuestas).xlsx | `Respuestas de formulario 1`, con encabezado | 322–323 (ver §3) | 322 |
| F10 | abogados unificado.xlsx | `PADRON UNIFICADO`; 1ª fila en blanco, encabezado en la 2ª | 1.069 (ver §3) | 1.063 |

## 2. Layouts por fuente

### F02 / F05 — listado de cursada (formato de reporte)
- Filas 1–3: leyendas fijas. Fila 6: `Número de Cursada` (valor en col C). Fila 7: `Fecha y hora:` (valor en col C). Fila 8: encabezado. Datos desde la fila 9.
- **F02:** número de cursada = `52010`, `Fecha y hora` = `09/09/2026 10 a 13 hs` (texto libre, hay que parsear fecha y franja; el año 2026 es explícito).
- **F05:** el número de cursada y la fecha de la hoja están **vacíos** (el `52469` solo está en el nombre del archivo). La fecha sigue pendiente, como dice la spec.
- Columnas (índice desde 0; encabezado real de la fila 8): `1` CUIL (sin guiones) · `2` Apellidos · `3` Nombres · `4` Fecha de ingreso · `5` Modalidad de contratación · `6` Repartición · `7` Área · `8` Nombre del jefe superior · `9` Email oficial · `10` Email alternativo · `11` Teléfono · `12` Régimen. La col `0` es un contador, no un dato de la persona.
- **No hay DNI**: la identidad sale del CUIL. Hay filas sin CUIL.

### F01 / F03 — respuestas en PDF
- Una tabla de 18 columnas, 12 con encabezado: `Marca temporal · CUIL sin guiones · APELLIDO Y NOMBRE · FECHA DE INGRESO · MODALIDAD DE CONTRATACION · REPARTICION · AREA · NOMBRE DEL JEFE SUPERIOR · DIRECCION MAIL OFICIAL · MAIL ALTERNATIVO · TELEFONO · ES AFILIADO A SUTECBA?`.
- **Apellido y nombre vienen en una sola celda**: no se separan automáticamente (se conservan crudos; ver §5).
- **Ninguno de los dos PDF nombra el curso ni trae fecha.** F01 se asocia a RCP solo por contexto (la spec); **F03 no se puede resolver a un curso desde el propio PDF**, queda pendiente de que alguien confirme el nombre exacto.

### F04 — Primeros auxilios psicológicos (encabezado propio)
`0` Marca temporal · `1` CUIL sin guiones · `2` Apellido · `3` Nombre · `4` Fecha de ingreso · `5` Modalidad · `6` Repartición · `7` Área · `8` Jefe superior · `9` Mail oficial · `10` Mail alternativo · `11` Teléfono · `12` ¿Afiliado a SUTECBA? La marca temporal es del formulario, **no** fecha de la actividad.

### F07 — padrón (encabezado propio)
`0` Apellido · `1` Nombre · `2` Cuit/Cuil (100 % con 11 dígitos) · `3` Teléfono particular · `4` Mail personal · `5` Teléfono celular · `6` Profesión · `7` Mail GCBA · `8` Repartición · `9` Dirección · `10` Departamento · `11` Situación de revista. Sin DNI.

### F10 — padrón de abogados
Encabezado con `APELLIDO · NOMBRE · CUIL · CELULAR`; las columnas 4–10 no tienen etiqueta (mayormente vacías, con números sueltos en 4–5 y emails en 8): se conservan crudas en `raw_data` sin interpretarlas. Sin DNI.

### F09 — inscripciones Oftalmo Teatro Colón (encabezado propio)
`0` Marca temporal · `1` Email (cuenta del formulario) · `2` Apellido · `3` Nombre · `4` Correo electrónico · `5` DNI · `6` Fecha de nacimiento · `7` Edad · `8` Obra social/prepaga · `9` Número de afiliado · `10` ¿Afiliado a SUTECBA? · `11` Celular · `12` Ministerio. Las columnas `13–18` están vacías o son restos de la planilla.

### F06 — padrón por sede (SIN encabezado): 4 layouts *(inferido por forma de los datos)*
Los valores de las columnas de categoría (obra social: OBSBA/OSDE/otra; afiliado SUTECBA: sí/no) y su correspondencia con F09 permiten deducir cuatro layouts. **Requieren tu confirmación**:

| Layout | Columnas (índice desde 0) | Dónde aparece |
|---|---|---|
| **L1** | 0 marca temporal · 1 email · 2 apellido · 3 nombre · **4 DNI** · 5 fecha nac. · 6 edad · 7 obra social · 8 ¿afiliado SUTECBA? · 9 celular · 10 ministerio/repartición · 11 extra | ASI, Ed. Canale y parte de Cruz Malta |
| **L2** | 0 marca temporal · 1 apellido · 2 nombre · 3 email · **4 DNI** · 5 fecha nac. · 6 edad · 7 obra social · 8 nº de afiliado · 9 ¿afiliado SUTECBA? · 10 celular · 11 ministerio · 12 email alternativo | Educación |
| **L3** | idéntico a F09: … 4 email 2 · **5 DNI** · 6 fecha nac. · 7 edad · 8 obra social · 9 nº afiliado · 10 ¿afiliado? · 11 celular · 12 ministerio | Teatro Colón |
| **L4** | 0 apellido · 1 nombre · 2 email · **3 DNI** · 4 fecha nac. · 5 edad · 6 obra social · 7 nº afiliado · 8 ¿afiliado? · 9 celular · 10 ministerio · 11 email 2 | Cruz Malta (≈40 % de la hoja, sin marca temporal) |

- **La hoja de Cruz Malta mezcla L1 y L4**: el layout se decide **por fila**, con la posición del email y del DNI (no por hoja).
- Detección por fila sobre los datos reales: L1 = 427, L2 = 30, L3 = 227, L4 = 83 y **24 filas sin layout reconocible** (9 Cruz Malta, 4 ASI, 2 Educación, 3 Teatro Colón, 6 Ed. Canale). Esas filas quedan en staging con incidencia; no se adivina.
- Texto libre suelto en la última columna de Ed. Canale (p. ej. días de la semana o notas): se guarda crudo. **No** es una fecha de atención.

### F08 — agenda de jornadas de oftalmología
22 filas con fecha real (2026-03-10 a 2026-05-14) y una fila final con solo el día de la semana y sin fecha (incidencia, no evento). Columnas: día · Fecha · Repartición · Dirección (contiene notas cortas de contacto, texto libre).

| Sede (normalizada) | Fechas |
|---|---|
| procuracion | 2026-03-10, 11, 12 |
| cruz-malta | 2026-03-17, 18, 19 |
| educacion (etiquetada "educacion 1") | 2026-04-01 |
| asi | 2026-04-08, 09 |
| canale | 2026-04-14, 15, 16 |
| teatro-colon | 2026-04-21, 22, 23, 24 |
| educacion (etiquetada "educación 2") | 2026-05-05, 06, 07 |
| infraestructura-escolar | 2026-05-12, 13, 14 |

`source_event_key` propuesto: `ophthalmology:<AAAA-MM-DD>:<sede>` (22 eventos). "educacion 1/2" son dos tandas de la misma sede: se distinguen por fecha, no por el sufijo. Ninguna hoja de F06/F09 trae fecha de atención: la marca temporal del formulario **no** cuenta.

## 3. Identidad medida sobre los originales

Reglas: DNI explícito de 7–8 dígitos; CUIL de 11 dígitos con dígito verificador válido; DNI derivado de las posiciones 3–10 del CUIL.

| Fuente | Filas | DNI explícito | CUIL presente | CUIL válido | DNI derivado | Con DNI canónico | Sin DNI |
|---|---:|---:|---:|---:|---:|---:|---:|
| F01 | 50 | 0 | 50 | 47 | 47 | 47 | 3 |
| F02 | 81 | 0 | 60 | 56 | 56 | 56 | 25 |
| F03 | 30 | 0 | 30 | 26 | 26 | 26 | 4 |
| F04 | 17 | 0 | 17 | 16 | 16 | 16 | 1 |
| F05 | 39 | 0 | 39 | 35 | 35 | 35 | 4 |
| F06 | 791 | 766 | 0 | 0 | 0 | 766 | 25 |
| F07 | 722 | 0 | 722 | 720 | 720 | 720 | 2 |
| F09 | 322 | 320 | 0 | 0 | 0 | 320 | 2 |
| F10 | 1.069 | 0 | 1.047 | 951 | 951 | 951 | 118 |
| **Total** | **3.121** | **1.086** | **1.965** | **1.851** | **1.851** | **2.937** | **184** |

- **DNI canónicos únicos: 2.015**; 833 DNI aparecen en más de una fila; máximo de apariciones: 7.
- **Ningún archivo trae DNI y CUIL a la vez**, así que dentro de una fila no hay contradicción posible; la de DNI ≠ CUIL solo puede aparecer al cruzar fuentes. Hoy, ningún CUIL válido apunta a dos DNI distintos.
- **Coincide con la spec en orden de magnitud** (3.115 filas, 1.098 DNI explícitos, 1.850 CUIL válidos, 2.948 con DNI canónico, 167 sin DNI, 2.020 únicos). Las diferencias son de detalle y se concilian en el dry-run: 24 filas de F06 sin layout reconocible, 6 filas de más en F10, una fila de más en F09 y una en CUIL presente. Hasta conciliarlas, el número operativo de "filas sin DNI" es **167–184**.

## 4. Riesgos de interpretación detectados
1. **Teléfonos de 11 dígitos con forma de CUIL**: en F06/F09/F10 muchos celulares tienen 11 dígitos. El CUIL solo se toma de columnas designadas *y* con checksum válido; nunca por la forma.
2. **`Número de afiliado` (obra social)** puede tener 11 dígitos o ser un DNI: no es CUIL ni identidad.
3. **Fechas de ingreso** llegan como número serial, fecha o texto; en F06 hay una celda con serial fuera de rango. Se normalizan con incidencia si no se pueden interpretar.
4. **F10, columnas 4–10 sin etiqueta**: no se interpretan.
5. **Nombres**: en F01/F03 vienen juntos; en el resto separados. No se unen personas por nombre.

## 5. Cosas que necesito que confirmes antes de fijar el importador
1. Los layouts **L1–L4** de F06 (especialmente que en L1 la columna 8 es "¿afiliado a SUTECBA?" y no otro dato).
2. Que F03 (`AGC-CAPACITACION 2026`) siga **pendiente**: el PDF no trae el nombre del curso.
3. Cómo tratar "educacion 1" y "educación 2" (mismo lugar, dos tandas): propongo una sola sede `educacion` y eventos separados por fecha.
4. Qué hacer con las 24 filas de F06 sin layout reconocible y con la fila final de F08 sin fecha: propongo incidencia (`UNRECOGNIZED_LAYOUT` / `MISSING_EVENT_DATE`) sin crear nada.
5. Si las 6 filas extra de F10 y la fila extra de F09 respecto de la spec deben tratarse como filas reales o como ruido.

## 6. Seguridad
- Originales y cualquier extracción con personas: fuera del repositorio; `/data/` está en `.gitignore` como protección adicional.
- Los reportes y logs no imprimen filas completas ni DNI/CUIL/emails/teléfonos.
- No se escribió nada en Supabase ni en PGlite con estos datos.

---

## Decisiones confirmadas y resultado del dry-run local (2026-09-21)

Decisiones cerradas: F06 con layouts L1–L4 detectados **por fila** (lo no reconocido → `UNRECOGNIZED_LAYOUT`, crudo conservado, sin persona); F03 solo staging (`PENDING_CLASSIFICATION`); Educación 1/2 = una sede `educacion`, una jornada por fecha; F08 sin fecha → `MISSING_EVENT_DATE`; F09 322 filas reales; F10 el encabezado REFERIDOS no es persona y los referidos sin CUIL quedan en staging (`MISSING_CANONICAL_DNI`); DNI canónico, CUIL aparte, DNI derivado de CUIL válido (`dni_source=derived_from_cuil`); nunca se fusiona por nombre/email/teléfono; sin DNI canónico no hay persona.

Conteos medidos sobre los originales (dry-run, nada escrito): 3.120 filas de persona · 1.085 DNI explícito · 1.851 derivado · 2.936 con DNI canónico · 184 sin DNI (166 `MISSING_CANONICAL_DNI` + 18 `UNRECOGNIZED_LAYOUT`) · 2.014 DNI únicos → 2.014 personas a crear, 0 a actualizar · 129 conflictos (email 76, organismo 28, nombre 15, teléfono 7, nacimiento 3) · 25 reuniones (1 fecha conocida, 22 solo día, 2 pendientes) · 914 inscripciones (107 a evento, 807 a campaña) · 0 asistencias · 493 incidencias.

Diferencias con la referencia previa: UNRECOGNIZED 18 (no 24) porque el detector exige solo nombres, posición de email y DNI numérico e ignora nacimiento/edad/marca temporal; INVALID_DNI_FORMAT 10 se informa aparte.

---

## Apply protegido, `date_only` y política de conflictos (2026-09-21)

**Horario.** `meetings.schedule_precision` ∈ `exact_datetime` (starts_at/ends_at reales) · `date_only` (solo `event_date`, sin hora) · `unknown` (sin fecha). Nunca se guarda una hora sintética. La UI muestra solo el día en `date_only`. Editar una actividad importada con fecha y hora reales la pasa a `exact_datetime`.

**Conflictos** (sin "último valor gana"): vacío + un único valor consistente → completa; mismo valor normalizado (mayúsculas, tildes, puntuación, espacios, formato de teléfono/email) → no es conflicto; valores distintos en un opcional (email, teléfono, nacimiento, organismo) → `FIELD_CONFLICT` no bloqueante, el campo queda vacío y se conservan todas las fuentes; nombres materialmente distintos (ninguno contiene las palabras del otro) o dos CUIL válidos → `BLOCKED_IDENTITY_CONFLICT`, la persona no se crea.

**Organismos.** `organization_id` solo con correspondencia exacta normalizada e inequívoca contra `organizations` activas (+ alias aprobados); si no, NULL + `ORGANISM_UNMAPPED`/`ORGANISM_AMBIGUOUS`. No se crean organismos ni se transfiere a nadie.

**CLI.** `npm run import:gabriel` = dry-run (imprime `plan_hash`). `--apply --confirm-plan <hash> --owner-organization-id <uuid> --created-by <uuid> --raw-dir <originales> [--yes]`. `plan_hash` = SHA-256 de un JSON canónico del plan derivado solo de los archivos (`lib/imports/gabriel/plan-hash.ts`). Verificaciones previas y lock: `lib/imports/gabriel/preflight.ts`.

---

## Estructura organizacional y alias (2026-09-21)

Catálogo de trabajo: `SUTECBA_Estructura_Oficial_Alias_Gabriel_v2.xlsx` (fuera de Git). `python tools/org-catalog-extract.py <xlsx> data/org-catalog/catalog.json` lo lleva a JSON con su SHA-256.

- `npm run org:catalog` → dry-run (sin base); `-- --db` → dry-run contra la base en transacción READ ONLY; `-- --apply --confirm-plan <hash> --created-by <uuid> --xlsx <catálogo.xlsx> [--yes]` → carga (mismas protecciones que el importador de Gabriel).
- `organizations`: una por fila de `Organismos_Oficiales`, `official_code = canonical_key`, padres antes que hijos, tipos nuevos en `organization_types`. Nunca desde texto libre.
- `organization_aliases`: solo AUTO_MAP=Sí, `approved`, un alias por texto comparable; PROBABLE/AMBIGUO/REVISAR/INVALIDO/histórico no se cargan. El importador resuelve **solo por alias aprobado** hacia una unidad activa (sin coincidencia por nombre ni fuzzy).
- `Alias_Area_Interna` no crea organizaciones: las unidades internas catalogadas oficialmente (ya cargadas desde `Organismos_Oficiales`) son organizaciones; el resto queda como dato de origen en staging.
- `npm run org:coverage` → simulación en memoria contra el dry-run de Gabriel (antes/después y Top de pendientes).

---

## Alias contextuales (0022, sin aplicar) — 2026-09-21

La jurisdicción forma parte de la resolución de un alias. `organization_aliases.context_organization_id` (NULL = global) más dos índices únicos parciales (global por texto; contextual por texto + contexto) y un trigger que impide que un global haga sombra a contextuales y que un contextual apunte fuera de su contexto.

- **Familias de homónimos** (derivadas del organigrama, no hardcodeadas): unidades del mismo tipo con el mismo nombre genérico (o con el código del padre como sufijo) y padres distintos. Hoy: DGTAL (5), «DG Técnica y Administrativa» (2), Unidad de Auditoría Interna (5). Vocabulario genérico: nombre, iniciales (DGTAL, UAI) y «DG …».
- **Contexto, por prioridad:** 1) la misma fila («Cultura / DGTAL»); 2) archivo de una sola jurisdicción (`lib/imports/gabriel/file-context.ts`: F07 → PG); 3) evidencia consistente de la misma persona. Contradicción → `ORGANISM_CONTEXT_CONFLICT`. Un área laboral libre nunca es contexto.
- Se guarda la unidad más específica comprobada (DGTALMC, no MCGC). La resolución contextual queda en `import_rows.normalized_data.organization`.

---

## F03 (AGC-CAPACITACION 2026): sigue `PENDING_CLASSIFICATION` — 2026-09-21

Decisión de SUTECBA: F03 queda fuera de toda actividad en la primera importación (no crea reunión ni participaciones; solo aporta la identidad de sus personas).

Evidencia recopilada (`gabriel_f03_revision.xlsx`), **NO es la identificación del curso**:
- 26 de las 26 personas con DNI canónico de F03 (30 filas; 4 sin DNI por CUIL inválido) aparecen también en **F05** (Inteligencia Emocional).
- 6 de esas 26 aparecen además en **F04** (Primeros Auxilios Psicológicos); ninguna aparece en F04 sin estar en F05.
- 1 aparece en F01 (RCP) y 2 en F02 (RCP 52010).

El solapamiento de personas no permite concluir que F03 sea F04 o F05.

## Identidades bloqueadas — decisiones humanas (incorporadas al plan)

`lib/imports/gabriel/identity-decisions.ts` + `tools/identity-decisions-extract.py`. Acepta exclusivamente `MERGE_SAME_PERSON`, `KEEP_BLOCKED`, `SOURCE_ERROR`, `REVIEW_LATER`; `MERGE_SAME_PERSON` exige `canonical_first_name` y `canonical_last_name`; un valor inválido o inconsistente ABORTA el plan. Exige una decisión por cada identidad bloqueada y ninguna para el resto. Cuando se use, las decisiones entran al JSON canónico (`planFromSources(files, { identityDecisionRows })`) y cambian el `plan_hash`. Ya las consume el plan (`--identity-decisions <json> --identity-decisions-xlsx <xlsx>`; el extracto lleva nombre y SHA-256 del XLSX y el importador lo verifica):

- `MERGE_SAME_PERSON`: se crea UNA persona con el DNI canónico y el nombre EXACTO `canonical_first_name`/`canonical_last_name` (no se elige por mayoría ni por «más completo»). Todas las filas fuente del DNI se vinculan a esa persona y conservan sus variantes originales en `raw_data`. Si además hubiera dos CUIL válidos distintos, la decisión de nombre no los resuelve: `cuil_cuit` queda vacío con un conflicto no bloqueante. En una segunda corrida el nombre guardado no se compara contra las variantes de la fuente (ya lo resolvió una persona).
- `KEEP_BLOCKED` / `REVIEW_LATER` / `SOURCE_ERROR`: no se crea persona; todas las filas quedan `in_review` y sin participaciones.
- El plan_hash cambia (las decisiones están en el JSON canónico; las notas no). Con las 14 decisiones aprobadas (11 MERGE, 1 KEEP_BLOCKED, 2 REVIEW_LATER): 2.014 identidades = 2.011 INSERT de `people` + 3 bloqueadas. El resumen del lote (`summary.identity_decisions`) guarda archivo, SHA-256, conteos y resultado por decisión, sin DNI ni nombres.

## Organización propietaria de las actividades — SUTECBA

Organización raíz independiente (`official_code = SUTECBA`, tipo `sindicato`, sin padre); nada del árbol GCBA cuelga de ella. El árbol GCBA representa la repartición laboral de las personas; SUTECBA es la propietaria/organizadora de reuniones, capacitaciones, operativos e importaciones (`--owner-organization-id`). `npm run org:owner` (dry-run) / `-- --apply --created-by <uuid> --yes`.

## Aliases aprobados por decisión humana

`lib/organizations/catalog/approved-additions.ts`: `Ministerio de Espacio Publico` → `MEPHUGC` y `Sindicatura General de la Ciudad` → `SGCBA` (globales, aprobados por SUTECBA el 2026-09-21). El resto de los pendientes sigue sin cargarse.
