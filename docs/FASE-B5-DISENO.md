# B5 — Timeline de Persona + definición de contacto real (diagnóstico y diseño, SIN implementar)

Estado: diseño **aprobado** (decisiones 1–17) e **implementado en local** (sin commit). Resultado final: **B5 no necesita migración** (0043 evaluada y descartada). Reglas finales en `docs/FASE-B-DISENO.md` §7.5. Próxima migración libre: **0043**.
Base auditada: commit `1e9bbe4` (B4 desplegada), producción en ledger 0042 (consultas de solo lectura, reportes en `sutecba-fuentes/reports/b4/b5_audit_prod*.txt`).

---

## 0. Resumen ejecutivo

1. **Hoy no existe ningún contacto real en el CRM.** Las 1.120 `person_interactions` son 100 % derivadas de participaciones históricas (`participated/legacy_initial_import`): tipo `participation`, sin canal, sin outcome, sin responsable, `source_key = meeting_participation:<id>`.
2. **Hoy el semáforo trata esas 1.120 como si fueran contacto.** 56 personas verdes, 911 rojas (861 de ellas por la fecha técnica 2026-01-01), 178.664 grises. Con la definición estricta de B5 las 179.631 quedarían en gris/«Sin contacto registrado» hasta que la Fase F registre contactos reales. **Esto es un cambio visible grande y necesita tu aprobación explícita (D1).**
3. **Modelo recomendado:** derivar (Opción A reforzada): una única definición `realContact` (SQL + espejo TS), basada en una lista blanca de origen, con un trigger de coherencia y un índice parcial. No agregar columna `counts_as_contact` manual.
4. **Timeline:** una sola consulta `UNION ALL` en un round trip, paginada por cursor, sin vistas ni materialized views. Prototipo medido en producción: **0,5 ms de ejecución en el servidor**; los ~160 ms observados son 100 % latencia de red de esta PC (un `SELECT 1` tarda 154 ms). Existe ruta indexada persona → hechos y persona → eventos en B2/B3/B4; **no hace falta ningún índice nuevo** para el timeline.
5. **Schema para la Fase F:** `person_interactions` NO alcanza todavía para comunicaciones manuales/masivas (falta dirección, estado de entrega, metadata, fecha desconocida, referente). Se propone resolverlo en la migración de F, no en B5. **B5 puede ir con 0 o 1 migración** (D6).
6. **Hallazgo de scope:** las interacciones hoy se filtran por la unidad *dueña de la interacción*, no por la persona. Contradice tu regla («visibilidad primaria = persona actual»). Hay que decidir cómo reconciliarlo (D4).

---

## 1. Principio conceptual (se mantiene)

Seis hechos independientes, nunca colapsados en un estado: **invitación ≠ respuesta ≠ inscripción ≠ participación ≠ asistencia ≠ interacción/contacto.**
Reglas ya cerradas que B5 NO cambia: asistencia no crea interacciones (B3); inscripción no crea interacciones (B4); `source_business_rule` nunca crea asistencia ni interacción.
`actividad ≠ contacto real`, `participación ≠ contacto real` salvo interacción explícita que lo justifique.

---

## 2. Auditoría de `person_interactions` (schema real, producción)

### 2.1 Columnas (21)
| # | Columna | Tipo | Null | Default / nota |
|---|---|---|---|---|
| 1 | id | uuid | NO | gen_random_uuid() |
| 2 | person_id | uuid | NO | FK people |
| 3 | owner_organization_id | uuid | NO | FK organizations. **Define quién ve la interacción** (ver 2.5) |
| 4 | occurred_at | timestamptz | NO | cuándo ocurrió |
| 5 | interaction_type_id | uuid | NO | FK interaction_types |
| 6 | channel_id | uuid | sí | FK interaction_channels |
| 7 | subject | text | NO | CHECK no vacío |
| 8 | description | text | sí | |
| 9 | status | text | NO | `open` \| `completed` \| `cancelled` \| `voided` (default `open`) |
| 10 | outcome | text | sí | **texto libre, sin vocabulario** |
| 11 | responsible_user_id | uuid | sí | FK users (único «responsable» que existe) |
| 12 | next_follow_up_at | timestamptz | sí | |
| 13 | meeting_id | uuid | sí | FK meetings (**no hay campaign_id**) |
| 14 | void_reason | text | sí | obligatorio si `voided` |
| 15 | created_by | uuid | NO | FK users (cuándo se *registró* = `created_at`) |
| 16 | created_at / 17 updated_at / 18 version | | NO | |
| 19 | occurred_precision | text | NO | `exact_datetime` \| `date_only` (**no existe `unknown`**) |
| 20 | source_key | text | sí | UNIQUE parcial; idempotencia de lo derivado |
| 21 | date_basis | text | NO | `actual` \| `legacy_reference` (0029) |

**No existen:** `direction`, estado de entrega, metadata/JSON, `campaign_id`, referente, `contact_class`, `counts_as_contact`.

### 2.2 Constraints, índices, triggers, RLS, grants
- CHECKs: status, subject no vacío, void_reason, precision, `date_only` = medianoche de Buenos Aires, source_key no vacío, `date_basis`, `legacy_reference` ⇒ `date_only` + 2026-01-01 00:00 BA.
- Triggers: `no_delete` (nunca se borra; se anula con `voided`) y `person_interactions_legacy_reference_guard` (legacy_reference solo con source_key de una participación `participated/legacy_initial_import`).
- Índices: pkey; `(person_id, occurred_at desc)`; `(person_id, occurred_at desc) WHERE status in (open,completed)`; ídem `AND date_basis='actual'`; `(owner_organization_id, occurred_at desc)`; seguimiento (`next_follow_up_at`); responsable; UNIQUE parcial `source_key`.
- RLS activa, política `sutecba_app_all`; `sutecba_app`: `INSERT, SELECT, UPDATE` (sin DELETE).
- Vocabularios (catálogos sembrados): **tipos** `consulta, llamada, gestion, visita, participation, otro`; **canales** `presencial, telefono, correo, whatsapp, formulario, otro`.
- **Dos vocabularios de canal distintos ya conviven:** interacciones (`telefono/correo/presencial…`) vs. invitaciones/inscripciones B2–B4 (`phone/email/in_person/sms…`). Falta `sms` en el catálogo de interacciones. Hay que mapearlos en un único módulo (ver §16).
- `association_interactions` e `interaction_links`: 0 filas.

### 2.3 Código que escribe / lee
| Qué | Dónde |
|---|---|
| **Crea** | `lib/interactions/participation-sync.ts` (única vía automática) y `legacy-reference-interactions.ts` (script `reconcile-legacy-reference-interactions`). Llamadores: `imports/gabriel/apply.ts`, `nuevas-apply.ts`, `legacy-reconciliation.ts`, script `reconcile-participation-interactions`. **Ningún flujo de runtime de la app crea interacciones hoy.** No hay UI ni acción manual para crearlas. |
| **Actualiza** | **Nadie.** No existe ningún `UPDATE person_interactions` en el código. |
| **Lee: «último contacto»/semáforo** | `lib/people/queries.ts` (`lastInteractionLateral` página, `lastInteractionDerived` filtros/KPIs/export, `getPersonTraffic` ficha), `lib/people/traffic*.ts` (umbrales 30/60). Todas usan `validInteraction()` = `status in (open,completed) and occurred_at <= now()` + `orgScope(owner_organization_id)`. **No distinguen origen.** |
| **Ordenar personas** | La grilla ordena por nombre/alta. La fecha de última interacción solo filtra (`lastInteractionFrom/To`), se muestra y se exporta. |
| **Dashboard/analytics** | `lib/analytics/queries.ts` → `getParticipationInteractionKpis` (`totalInteractions`, `uniquePeopleWithInteraction`, «fecha real» vs «solo referencial») y KPIs del semáforo. |
| **Ficha de persona** | `getPersonTraffic` (badge + texto). La sección «Actividad» NO usa interacciones: usa `getPersonMeetingActivity` (un estado colapsado por reunión). `listPersonInteractions` existe pero **ninguna pantalla lo usa**. |
| **Previews/reportes** | `legacy-reconciliation.ts`, `legacy-reference-interactions.ts` (proyecciones de semáforo). |

### 2.4 Fechas existentes (cuándo ocurrió / cuándo se registró / precisión / fuente)
- **Ocurrió:** `occurred_at` + `occurred_precision` (`exact_datetime`/`date_only`). **Registro técnico:** `created_at` (+ `created_by`). **Fuente de la fecha:** solo `date_basis` (`actual`/`legacy_reference`); no hay `unknown`.
- El modelo es coherente con B2/B3/B4 salvo por la falta de `unknown` (en B2–B4 una fecha desconocida es NULL + precisión NULL). Nunca se debe usar `created_at` como fecha de contacto.

### 2.5 Hallazgo de scope (importante)
`lib/interactions/queries.ts` y el semáforo filtran por **`owner_organization_id` de la interacción**, no por la persona (decisión de 0017: un traslado no expone interacciones históricas). En producción: 770 interacciones con dueño = unidad actual de la persona, **319 de personas sin organización** (dueño = organizadora de la actividad), **31 con dueño ≠ unidad actual**. Para esas 31, un usuario de la unidad actual de la persona **no ve** su «última interacción»; y un usuario de la unidad dueña, que ya no ve a la persona, sí vería la interacción (si llegara a listarla). Contradice la regla de B5 (la persona manda).

---

## 3. Estado real de producción (solo lectura)

| Métrica | Valor |
|---|---|
| Filas / personas distintas | **1.120 / 967** (149 personas con 2+) |
| Unidades dueñas / reuniones distintas / con responsable | 58 / 7 / **0** |
| Tipo | `participation`: **1.120** (100 %) |
| Canal | NULL: **1.120** · outcome NULL: **1.120** · status `completed`: **1.120** |
| Descripción / seguimiento / responsable | **0 / 0 / 0** |
| `source_key` | 100 % `meeting_participation:<id>` · un solo `created_by` |
| Origen (participación) | **100 % `participated/legacy_initial_import`** |
| Con `meeting_id` / sin | 161 / **959** (campaña sin jornada) |
| Creadas | 2026-09-22 (56), 2026-09-23 (54), 2026-09-24 (1.010) |

### `date_basis` (la cifra pedida)
| date_basis | filas | personas | precisión | detalle |
|---|---|---|---|---|
| `actual` | **110** | 106 | 56 `exact_datetime` (capacitaciones) + 54 `date_only` (operativos de salud) | 2026-04-09 … 2026-09-09 |
| `legacy_reference` | **1.010** | 879 | 1.010 `date_only` (2026-01-01) | **959** de campaña sin jornada + **51** de una capacitación sin fecha |
| `unknown` | **no existe** | | | |

→ La cifra «959» histórica es solo la parte de campaña; el total `legacy_reference` actual es **1.010**.
→ Personas solo con `legacy_reference`: **861**; con alguna `actual`: 106 (861 + 106 = 967).
→ **Ninguna** de las 1.120 es un contacto real según la definición propuesta (todas nacen de una participación). Las 110 `actual` tienen fecha real de la *actividad*, no de un contacto.
→ Participaciones elegibles sin interacción: **0** (la sincronización está al día).

### Semáforo hoy vs. alternativas (179.631 personas)
| Regla | Verde | Amarillo | Rojo | Gris |
|---|---|---|---|---|
| **Hoy** (cualquier interacción válida) | 56 | 0 | **911** | 178.664 |
| Solo `date_basis='actual'` | 56 | 0 | 50 | 179.525 |
| **Contacto real estricto (B5)** | 0 | 0 | 0 | **179.631** |

### Participaciones (para el timeline)
5.581 filas / 4.223 personas: `participated/source_business_rule` 3.500 (3.356 con jornada + 144 campaña) · `participated/legacy_initial_import` 1.120 (959 campaña + 161 jornada) · `registration/standard` 961 (805 jornada + 156 campaña; 812 personas). Máx 9 por persona, p99 = 4. Eventos B2/B3/B4, invitaciones, asistencias: **0** filas.
Referente: **0** rastros (`import_rows.raw_data` sin «referente»; `association_managers` 0 filas).

---

## 4. Auditoría de `syncParticipationInteractions`

- **Rama activa:** solo «1. Participaciones confirmadas». La rama de asistencia fue removida en B3 (el punto 2 es un comentario). Los campos `reactivated`/`voided` del resultado son vestigiales (siempre 0).
- **Procesa:** `participation_kind='attended'` (cualquier base; exige jornada + fecha; **0 filas en producción**) y `participated` + `legacy_initial_import`. **No procesa:** `registration`, `participated/source_business_rule`, `invited/absent/approved/unknown`, ni `meeting_attendance`.
- **Crea:** tipo `participation`, `status='completed'`, `channel NULL`, `outcome NULL`, sin dirección (no existe la columna), sin responsable, `subject` = «Participó en …», `description` NULL, `meeting_id` = la jornada, `owner` = unidad de la persona (o, si no tiene, la organizadora), `created_by` = actor/organizador/creador, `source_key = meeting_participation:<id>`.
- **Fecha:** la de la actividad (`exact_datetime` o `date_only`); sin fecha → no crea (se informa como omitida). Campaña sin jornada → nunca (el JOIN con `meetings` la excluye); esas 959 las creó el script `legacy-reference-interactions` con la fecha técnica.
- **Anula/reactiva:** nunca. Solo `INSERT … ON CONFLICT (source_key) DO NOTHING`.
- **Quién lo invoca:** importadores y scripts de mantenimiento; ningún flujo de usuario.
- **Conclusión:** es un *espejo técnico de la participación*, no un contacto. B5 no lo toca.

---

## 5. Definición propuesta de «contacto real»

> **Contacto real** es una comunicación o interacción efectiva entre el CRM (a través de un operador o referente identificable) y la persona, registrada como una **interacción explícita** de tipo comunicación, con canal, fecha de ocurrencia y responsable, que no es un espejo derivado de otro hecho del sistema.

Regla ejecutable (`realContact(interaction)`), todas las condiciones:
1. `status` válido (`open`/`completed`) y `occurred_at <= now()`; no `cancelled`/`voided`.
2. **Origen manual o de comunicación explícita:** `source_key IS NULL` (carga manual) **o** namespace de comunicación permitido (`communication:*`, reservado para F; hoy ninguno). **Lista blanca**: un origen nuevo NO cuenta hasta que se lo habilite expresamente.
3. **No derivada de actividad:** `source_key NOT LIKE 'meeting_participation:%'` y tipo ≠ `participation`.
4. `date_basis = 'actual'`.
5. Resultado de comunicación efectiva (vocabulario de F): cuenta si es enviada por el CRM/operador o recibida/respondida por la persona; **no** cuentan `failed`, `bounced`, `unsubscribed` como contacto; `opened/clicked` son señales de engagement de un contacto previo (aparecen en el timeline, no mueven «último contacto» por sí solas).

| Hecho | ¿Contacto real? |
|---|---|
| WhatsApp/SMS/email enviado, llamada, visita, conversación presencial, nota de referente (como interacción manual explícita) | **Sí** |
| Respuesta de la persona a una comunicación (reply, inbound) | **Sí** |
| Email abierto/clickeado | Solo timeline (engagement) |
| Invitación creada · inscripción · participación · asistencia · aparecer en una base · importación · `source_business_rule` · `legacy_reference` · `created_at` · pertenecer a campaña · tag | **No** |
| Aceptación de invitación | Ver §6 |

---

## 6. Respuesta a una invitación: ¿contacto real?

Opciones: A) toda respuesta; B) solo canales comunicacionales; C) ninguna (solo timeline); D) otro.
- La invitación de B2 **no prueba** que el CRM envió algo («registrar el canal no significa que se haya enviado»); el enlace público es un clic, no una conversación.
- Una respuesta cargada por un operador por WhatsApp/teléfono sí documenta una comunicación, pero hoy es un dato de la invitación, no una interacción.

**Recomendación (D = C ahora + puente explícito):**
- **B5:** ninguna respuesta de invitación alimenta `person_interactions` ni «último contacto». Aparece en el timeline (categoría Invitación) con la marca «No cuenta como contacto».
- **Fase F:** acción explícita «Registrar como contacto» (operador confirma) para una respuesta cargada por canal comunicacional (WhatsApp/teléfono/email/SMS/presencial): crea **una interacción manual** (con el canal real, el operador y la fecha de la respuesta). **Nunca automático** y **nunca para `public_link`**. Coherente con B3/B4 (los hechos no se derivan solos).

---

## 7. Las 1.120 históricas: cómo excluirlas sin destruirlas

- Representan **participación histórica** (decisión de negocio 0028/0029), no comunicación: sin canal, sin responsable, `legacy_reference` en el 90 %, y el 10 % `actual` tiene fecha de actividad.
- **No se borran ni se modifican** (cero escrituras en producción).
- Se excluyen por la **regla de §5** (origen `meeting_participation:*`, tipo `participation`): el filtro es de lectura.
- En el timeline **no se muestran como evento propio** (son la sombra técnica de la participación, ya mostrada como «Participó»); solo Master las ve en un detalle técnico. Siguen contando en la métrica técnica «Interacciones registradas» del dashboard, rotulada como tal.

---

## 8. Modelo para determinar contacto real: A vs. B

| Criterio | A) Derivado por reglas | B) Columna explícita (`counts_as_contact` / `contact_class`) |
|---|---|---|
| Migración | 0 (o 1 liviana de guarda/índice) | Sí + backfill de 1.120 filas (UPDATE sobre datos de producción) |
| Estado duplicado | No | Sí (puede divergir de `source_key`/tipo) |
| Robustez hoy | Alta: el discriminador (`source_key meeting_participation:%` + tipo `participation`) es 100 % determinista (1.120/1.120) | Alta pero redundante |
| Auditabilidad | Reglas en **un** módulo + test de escaneo de lecturas | Un campo visible, pero editable → riesgo de bandera manual errónea |
| Rendimiento | Predicado intra-fila → **índice parcial** posible | Índice parcial trivial |
| Ambigüedad real | Ninguna hoy. Aparecería con orígenes nuevos de F (imports de WhatsApp/mailing) | Se resuelve fila a fila |

**Recomendación: A reforzada.**
1. Una sola definición: `realContactSql(alias)` en `lib/people/traffic-sql.ts` (o `lib/contacts/real-contact.ts`) + espejo TS `isRealContact()`; **ninguna otra lectura** arma su propio filtro (test que escanea el código, como el de B4).
2. **Lista blanca** de origen (§5).
3. **Trigger de coherencia (0043, opcional):** `type='participation' ⇔ source_key LIKE 'meeting_participation:%'`; impide que algo derivado se cuele como manual o al revés (mismo patrón que `legacy_reference_guard`).
4. **Índice parcial (0043, opcional):** `(person_id, occurred_at desc) WHERE status in (open,completed) AND date_basis='actual' AND (source_key IS NULL OR source_key NOT LIKE 'meeting_participation:%')`. Con 0 contactos reales es irrelevante hoy; evita un escaneo cuando F cargue volumen.
5. Si en F aparece ambigüedad real, evaluar `contact_class` entonces (con la evidencia de los nuevos orígenes).

---

## 9. «Último contacto real»

Una fila por persona (la más reciente), con: **fecha** (día de Buenos Aires + precisión), **tipo**, **canal**, **outcome**, **responsable** (usuario), **origen** (manual / comunicación), **dirección** (cuando F la tenga), **actividad/campaña** relacionada (`meeting_id`, y `campaign_id` cuando F lo agregue).
Algoritmo: `realContact(...)` ∧ persona en alcance → `ORDER BY día desc, occurred_at desc, id` `LIMIT 1` (lateral para páginas; `DISTINCT ON` para filtros/KPIs/export, como hoy). Empate de día: mayor `occurred_at`, luego id.
**Nunca** lo mueven: participación, asistencia, inscripción, importación, `legacy_reference`, respuesta de invitación. Sin contacto: **«Sin contacto registrado»**; nunca se muestra una fecha técnica como sustituto.

---

## 10. Modelo de fechas (consistente con B2/B3/B4)

Cada hecho del timeline expone `at` + `precision` + `atSource`:
- `exact_datetime`: instante conocido. `date_only`: solo el día (se muestra sin hora; ordena al inicio del día BA). `unknown`: sin fecha → `at = null`.
- **La fecha es la del hecho, no la de la actividad**, salvo donde el hecho *ocurre* en la actividad (participación/asistencia). La inscripción histórica (sin `registered_at`) es **sin fecha** aunque la actividad tenga fecha: se muestra «Fecha no registrada — actividad del dd/mm/aaaa».
- `created_at` nunca se usa para ordenar ni como fecha de contacto. Los eventos de B2–B4 usan `occurred_at` (cuándo se *registró* la acción) y los campos propios del hecho para cuándo *ocurrió*.

---

## 11. Timeline unificado — modelo del evento

```
TimelineEvent {
  id            // estable: "<origen>:<id>" (para cursor y deduplicación)
  category      // invitation | registration | participation | attendance | contact
  kind          // invited, reinvited, withdrawn, responded, response_changed, registered, voided, restored, participated, checked_in, revoked, interaction…
  title, description
  at | null, precision, atSource     // 'fact' | 'activity' | 'unknown'
  origin                             // texto humano: "Listado importado", "Carga manual", "QR", "Enlace público"…
  recordedBy | null                  // nombre solo si el lector puede gestionar (convención B2/B4)
  activity { id, type: meeting|campaign, name } | null
  provenance[]                       // frases humanas (reutiliza participants.ts)
  countsAsContact: boolean           // true solo para category=contact y realContact()
  technicalDetail?                   // solo Master (ids, source_key)
}
```
Fuentes y mapeo:
| Categoría | Fuente | Fecha |
|---|---|---|
| Invitación | `meeting_invitations` + `meeting_invitation_events` | `occurred_at` del evento |
| Inscripción | `meeting_participations (registration)` + `meeting_registration_events` | `registered_at` (NULL en las 961 históricas) |
| Participación | `meeting_participations (participated)` (`source_business_rule` y legacy) | fecha de la actividad; campaña sin jornada → sin fecha |
| Asistencia | `meeting_attendance` + `meeting_attendance_events` | check-in/`occurred_at` |
| Contacto | `person_interactions` filtradas por `realContact` | `occurred_at` + precisión |
| (extra) | formularios (`form_submissions`, hoy 0), traslados de unidad (hoy 0) | opcional, categoría «Otros» |

---

## 12. Eventos sin fecha — UI

Dos bloques en la misma lista:
1. **Con fecha**, orden descendente; los `date_only` muestran solo el día.
2. **«Sin fecha registrada»** al final (colapsable, con contador): `Fecha no registrada — Inscripción histórica en Jornada Y (actividad del 12/03/2026)`; `… — Participó en Campaña X (jornada no determinada)`.
Nunca se intercalan con los fechados ni se ordenan por `created_at`. El cursor tiene dos tramos (fechados → sin fecha), orden estable `(at desc nulls last, categoría, id)`.

---

## 13. Qué historial de mutaciones ve el usuario

| Acto | ¿Aparece? | Cómo |
|---|---|---|
| invited / responded | Sí | entrada propia |
| response_changed (cambio real de respuesta) | Sí | «Cambió su respuesta: Aceptó → Rechazó» |
| response_changed con from = to (corrección de metadata) | No | detalle de la entrada |
| withdrawn / reinvited | Sí | hechos relevantes |
| registered | **Es la entrada de la inscripción** (no se duplica) | |
| voided / restored | Sí | con motivo (si puede gestionar) |
| corrected (inscripción/asistencia) | Detalle de la entrada («fecha corregida») | no genera línea propia |
| checked_in | Es la entrada de asistencia | |
| revoked / restored (asistencia) | Sí | con motivo |
Ruido técnico (ids, `seq`, `source_key`) → solo Master.

---

## 14. Regla anti-duplicados

**Una entrada por hecho + una por acto administrativo relevante.**
- El hecho se dibuja desde su fila/evento «de origen» (`registered`, `checked_in`, `invited`, `responded`): el evento provee quién/cuándo/canal, **no** una segunda línea.
- Si la fila no tiene eventos (históricos), se usa la fila + `provenance`.
- Interacciones con `source_key = meeting_participation:*` **se suprimen** del timeline (ya existe la entrada «Participó»).
- Las participaciones `participated` (fila única) nunca tienen eventos: no hay posibilidad de doble línea.

---

## 15. Participaciones sin eventos

Las `participated` (`source_business_rule`, `legacy_initial_import`) entran como hechos históricos con: fecha de la actividad si existe (si no, «sin fecha»), `provenance` («Participación según regla del listado F05», «Participación histórica inicial»), marca «No cuenta como contacto». **No se crean eventos retroactivos.** Las `registration` históricas igual (sin fecha, «Inscripción según listado importado»).

---

## 16. Preparación para la Fase F (contactos manuales) — ¿alcanza el schema?

Alcanza para: operador (`created_by`/`responsible_user_id`), fecha + precisión, tipo, canal, notas (`description`), reunión opcional, anulación, seguimiento.
**No alcanza para:** `direction`; estado de entrega/engagement estructurado (`outcome` es texto libre, hoy todo NULL → se puede constrenir sin riesgo); metadata de mensaje/campaña; `campaign_id`; fecha **desconocida** (`occurred_at` NOT NULL y precisión sin `unknown`); referente que no es usuario; canal `sms`; vocabulario único de canales.
**Propuesta:** definir en B5 solo el *contrato* (§17, §19, clasificación) y dejar las columnas para la migración de F (0044+): `direction`, `delivery_status`/`outcome` constrenidos, `metadata jsonb`, `campaign_id`, `referent_person_id`, `occurred_precision='unknown'` (con `occurred_at` NULL, y todas las lecturas filtrando por fecha conocida), seed de `sms`. B5 no adelanta nada de eso.

---

## 17. Emails/WhatsApp históricos — compatibilidad

Hoy no hay ninguno en `person_interactions` (100 % `participation`). El modelo actual soporta **sent** y **replied** (como filas distintas) pero no **delivered/opened/clicked/failed/unsubscribed** con granularidad, ni fecha desconocida, ni metadata de envío. Recomendación para F: **una interacción por mensaje** con `delivery_status` = estado más alto alcanzado y los instantes en `metadata`; `unsubscribed` es **estado de la persona** (no interacción). No se implementa nada ahora.

---

## 18. Vocabulario canónico propuesto (para F; no se agrega en B5)

- **direction:** `outbound` · `inbound` · `bidirectional` · `unknown` (reemplaza «system»: lo del sistema no es contacto).
- **delivery_status** (mensajes): `sent` · `delivered` · `opened` · `clicked` · `replied` · `failed` · `bounced`. **outcome** (conversación): `positive` · `negative` · `neutral` · `no_answer`. (`unsubscribed` → estado de la persona.)
- Mapear siempre a un vocabulario único de **canal**: `whatsapp, email, sms, phone, in_person, other` (el de B2–B4), con tabla de equivalencias a `interaction_channels` (`telefono→phone`, `correo→email`, `presencial→in_person`, `formulario→other`).
Se parte del vocabulario existente (catálogos de tipo/canal) y se agrega solo lo que falta (`sms`, dirección, estados).

---

## 19. Referente

No existe en el modelo (0 rastros). Lo único cercano: `responsible_user_id` (usuario del CRM) y `association_managers(person_id, user_id)` (0 filas, referente de *asociación*). **Modelo mínimo (F):** `responsible_user_id` = quien registró/responde; opcional `referent_person_id → people` si el referente es una persona del padrón; si no, texto en `description`. El timeline mostrará «Contacto realizado por [responsable/referente]» **solo** si el dato existe; no se inventa ninguna relación en B5.

---

## 20. Scope

Regla: **si no puede ver a la persona, no ve su timeline** (`canAccessPerson`: Área → descendientes; Repartición → propia; sin organización → solo Master).
Casos que pueden romperla:
1. **Interacciones filtradas por `owner_organization_id`** (31 con dueño ≠ unidad actual): decisión **D4**. Propuesta: la persona manda; el *hecho* de contacto (fecha, canal, tipo) lo ve cualquiera que vea a la persona; el **detalle** (`subject`/`description`/`outcome`) solo si el dueño de la interacción está en su alcance (o es Master).
2. **Nombre de la actividad** de otra unidad: hoy `meetingVisibility` ya la hace visible si hay participantes del lector; para una inscripción **solo anulada** (no cuenta en `meetingVisibility`) se muestra título genérico «Actividad de otra unidad».
3. **Nombres de operadores y motivos:** solo con `meetings.manage_invitations` (misma convención de B2/B4).
4. **Traslados de unidad:** el alcance es el *actual* de la persona (consistente con el resto del CRM).

---

## 21. Datos sensibles

Hoy `applyMasking` oculta DNI/teléfono/email sin `people.view_sensitive` en la ficha. En el timeline:
- Todo texto lo arma el servidor desde campos estructurados (sin concatenar DNI/teléfono/email).
- Texto libre de interacciones (`subject`, `description`, `outcome`, notas de F): se muestra solo con `interactions.view` y dueño en alcance; sin `people.view_sensitive` se aplica **enmascarado de patrones** (DNI 7–8 dígitos, teléfonos, emails) además del control de alcance. Las respuestas de formularios (hoy 0) no se vuelcan al timeline.
- `technicalDetail` solo Master.

---

## 22. Query/API del timeline — comparación

| Opción | Veredicto |
|---|---|
| A. `UNION ALL` SQL en un round trip | **Elegida** |
| B. N consultas en paralelo | Medida: mismo tiempo en red baja, pero 5 conexiones del pool (límite 10) y un orden/cursor que se arma en memoria |
| C. Vista SQL | Innecesaria; parametrización por persona + filtros de scope no se benefician |
| D. Materialized view | **No** (volumen mínimo; agrega staleness) |
| E. Servicio agregador | Equivale a A, implementado en `lib/people/timeline.ts` |

Diseño: `getPersonTimeline(actor, personId, { categories?, cursor?, limit=30 })`: verifica `canAccessPerson` y, en **una** sentencia, une las fuentes de §11 (eventos de B2–B4 se alcanzan **desde su fila padre indexada por persona**), aplica `realContact` y el filtro de categoría, y devuelve `limit+1` filas para el cursor `(at, categoría, id)`; los sin fecha en un segundo tramo del mismo cursor. Sin N+1.

---

## 23. Performance (medida en producción, solo lectura)

- Prototipo `UNION ALL` (participaciones + eventos B2/B3/B4 + interacciones) con `LIMIT 50`: **Execution Time 0,531 ms**, planning 4 ms, 34 buffers (persona con 9 participaciones).
- Desde esta PC: `SELECT 1` = **154 ms** (mediana); timeline persona con 9 participaciones = **167 ms**; persona típica = **165 ms**; 5 consultas paralelas = 156 ms. Todo el tiempo es red → objetivo **< 300 ms: cumplido**; desde la VPS será menor.
- Índices por persona **ya existentes**: `meeting_participations_person_idx`, `meeting_invitations_person_id_idx`, `meeting_attendance_person_idx`, `person_interactions_person_date_idx`, `person_org_transfers_person_idx`. Los eventos se alcanzan por `invitation_id` / `attendance_id` / `participation_id` (índices existentes) desde la fila padre → **no se necesita índice por `person_id` en las tablas de eventos** (el prototipo lo hizo con scan secuencial en `meeting_registration_events` por estar vacía; la implementación real irá por `participation_id`).
- Pendiente de medir en la copia restaurada con datos sintéticos: una persona con ~200 eventos (peor caso) y 50.000 interacciones de F.

---

## 24. UI de la ficha de persona

1. **Resumen:** organización/área/repartición, DNI y contacto (enmascarados según permiso), etiquetas, observaciones (como hoy).
2. **Estado de relación** (tarjetas separadas, nunca mezcladas):
   - **Último contacto real** — fecha + canal + responsable, o **«Sin contacto registrado»** (con semáforo).
   - **Última actividad** — último hecho fechado de cualquier categoría (§25).
   - **Última inscripción vigente**, **Última participación**, **Última asistencia vigente** — cada una con su fecha o «Fecha no registrada».
3. **Timeline** con chips: **Todo · Contactos · Invitaciones · Inscripciones · Actividades · Asistencia** (conteo por chip), lista paginada con «Cargar más», bloque «Sin fecha registrada» al final, marca «No cuenta como contacto» en los hechos que no lo son.
4. La sección actual «Actividad» (estado colapsado por reunión) se **reemplaza** por el timeline; `getPersonMeetingActivity` queda marcado como deprecado.

---

## 25. Última actividad vs. último contacto

- **Último contacto** = `realContact` más reciente (§9).
- **Última actividad** = hecho **vigente y fechado** más reciente entre: inscripción (por `registered_at`, si existe), participación (fecha de la actividad), asistencia vigente (check-in) y contacto. Excluye actos administrativos, anuladas/revocadas, retiradas, invitaciones sin respuesta, fechas futuras, y todo lo sin fecha.
- Una asistencia reciente mueve «Última actividad» pero **no** «Último contacto».

---

## 26. Semáforo / estado de relación

Hoy: badge Verde ≤30 d · Amarillo 31–60 · Rojo >60 · Gris «Nunca interactuamos»; calculado desde la última interacción válida de **cualquier** origen; aparece en la grilla (columna, filtro, KPIs), en la ficha, en el export y en el dashboard.
**Propuesta:** calcular **exclusivamente** desde `último contacto real`; gris = **«Sin contacto registrado»** (sin fecha técnica, jamás rojo por «10 años»); textos de la UI: se elimina «Ref. … no comprobada» y «Fecha de referencia» (ya no hay fechas técnicas en esta vista). Dashboard: reemplazar «Última interacción con fecha real / solo referencial» por «Personas con contacto real» y rotular «Interacciones» como «Interacciones técnicas (derivadas de participaciones)».
**Impacto al lanzar B5:** 179.631 personas en gris (hoy: 56 verde / 911 rojo). Hasta que F registre contactos, el semáforo no discrimina. Alternativas en **D1**.

---

## 27. Plan de implementación (propuesto; aprobación independiente por subetapa)

| Subetapa | Contenido | Migración |
|---|---|---|
| **B5a — Dominio** | `realContact` (SQL+TS) único y testeado; módulo `lib/people/timeline.ts` (consulta, tipos, cursor, sanitización, scope); tests de escaneo (nadie más lee `person_interactions` para «contacto»); extender `docs/FASE-B-DISENO.md` | **0043 opcional**: trigger de coherencia + índice parcial de contacto real |
| **B5b — Ficha** | Estado de relación + timeline + filtros + bloque sin fecha; deprecar `getPersonMeetingActivity` | no |
| **B5c — Semáforo y KPIs** | Grilla (columna/filtro/KPIs/export), `getPersonTraffic`, dashboard, copy («Sin contacto registrado») sobre `último contacto real` | no |
| **B5d — Verificación** | Tests (clasificación, scope, sanitización, dedupe, fechas, paginación, no-regresión B1–B4), suite completa, build, copia restaurada + datos sintéticos de volumen, medición, plan de producción | — |

Producción: sin migración (o 0043 aditiva) → backup → preflight → [0043] → deploy mío; smoke de solo lectura.
Tests clave: las 1.120 jamás son contacto real; semáforo estricto; asistencia/inscripción/participación no mueven «último contacto»; timeline sin duplicados (fila+evento); `legacy_reference` nunca como contacto ni como fecha; sin fechas inventadas; scope (Master / Área / sin organización / traslado / dueño ≠ persona); sin fuga de nombres/motivos/DNI; cursor estable con fechados y sin fecha.

---

## 28. Decisiones que necesito de vos

- **D1 — Semáforo en gris total.** (a) Aceptar: queda todo «Sin contacto registrado» hasta F. (b) Mantener la columna pero ocultar los KPIs/colores del semáforo hasta F, con un aviso. *Recomiendo (a) con el aviso del dashboard.*
- **D2 — Respuesta a invitación:** *Recomiendo D = C ahora + puente explícito «Registrar como contacto» en F.*
- **D3 — Modelo:** *A reforzada* (§8) vs. columna `contact_class`.
- **D4 — Scope de interacciones:** *la persona manda* para el hecho; detalle sujeto al dueño. ¿Aprobás tocar la regla de 0017 solo en lectura?
- **D5 — Engagement:** `opened/clicked` solo en timeline (no mueven «último contacto»). ¿OK?
- **D6 — Migración 0043:** (i) ninguna en B5; (ii) trigger de coherencia + índice parcial. *Recomiendo (ii) por robustez, es aditiva y no toca datos.*
- **D7 — Timeline:** ¿incluir formularios y traslados de unidad como categoría «Otros» o dejarlos fuera de B5?
- **D8 — Interacciones técnicas:** ¿ocultar para todos y mostrar solo a Master el detalle técnico, o no mostrarlas nunca?

---

## 29. Riesgos

Cambio visible grande del semáforo (D1) · divergencia de scope si no se resuelve D4 · reglas de contacto dispersas si alguien arma su propio filtro (mitigado con definición única + test de escaneo) · vocabularios de canal duplicados · `person_interactions.occurred_at NOT NULL` complica fechas desconocidas en F · latencia: la red de Supabase domina (el servidor responde en <1 ms) · deprecar `getPersonMeetingActivity` toca la ficha (test de regresión).
