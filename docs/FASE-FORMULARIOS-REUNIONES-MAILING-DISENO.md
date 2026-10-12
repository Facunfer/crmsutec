# Formularios, Reuniones y Mailing masivo (Amazon SES) — auditoría y diseño (SIN implementar)

Estado: **solo auditoría y diseño**. Sin código, migraciones, commit, push, AWS real ni deploy.
Base auditada: commit `114c191` (B5 desplegada), producción en ledger 0042. Próxima migración libre: **0043** (B5 no usó ninguna).
Datos de producción: consultas de solo lectura (`sutecba-fuentes/reports/b4/fm_audit_prod.txt`).

---

## 0. Resumen ejecutivo

1. **Formularios ya existe y es mucho más que un esqueleto** (Etapa 8): formularios versionados, campos, acciones, envíos con idempotencia, formulario público `/f/[slug]`, rate limit en tabla, bandeja de duplicados `/formularios/revision`, exportación CSV. **En producción hay 0 formularios y 0 envíos**: nunca se usó. Lo que falta es lo que este pedido agrega (vínculo con campaña/reunión, «Inscribir», importación CSV, bandeja de no vinculadas) y **corregir dos comportamientos que contradicen la regla nueva**: hoy un envío **crea personas automáticamente** (con DNI válido) y **completa datos de la persona** (`fill_empty_only`).
2. **Reuniones ya cubre casi todo** el flujo (B1–B5 cerradas): máquina de estados con UI, invitaciones, respuestas, inscripción, asistencia, QR/live, historial. Faltan: **capacidad**, **selección de campaña al crear/editar** (las campañas hoy son solo lectura en la app), y **vincular/crear formulario desde la reunión**.
3. **Mailing no existe** (ni dependencias AWS/mail en `package.json`). `notification_outbox` existe pero está vacío y es de forma libre: **no se reutiliza**; se propone un set propio.
4. **Dos hallazgos que cambian el plan:**
   - **Solo 4.078 de 179.631 personas (2,3 %) tienen email** (4.036 con formato válido, 4.059 distintos, 16 emails compartidos por 35 personas). El ejemplo «tag abogados → 8.000 con email» **no refleja la base actual**: el tag «abogado» tiene 175.162 personas, pero el universo mailable real hoy ronda **~4.000**. El tope de 15.000/día no es limitante hoy; sí lo será si los formularios recolectan emails.
   - **No hay dominio**: la VPS sirve por IP con certificado autofirmado. **Sin dominio propio no hay DKIM/SPF/DMARC alineados, ni enlaces de baja con HTTPS válido, ni endpoint SNS público**. Es el bloqueante nº 1 del mailing y no es de código.
5. **Arquitectura SES recomendada:** Configuration Set → SNS → **SQS** (el worker sondea; sin endpoint público ni certificado), worker propio como segundo proceso PM2, cuota global con un libro diario atómico en PostgreSQL (día Buenos Aires), reserva-antes-de-enviar, y **nunca reintentar un envío incierto** (evita duplicados).
6. **Migraciones: solo dos** — `0043` (formularios/reuniones) y `0044` (mailing). Permisos y módulo `mailing` van por catálogo + seed.
7. **Estimación: ~42–50 días hábiles** de implementación + prerrequisitos externos (dominio, cuenta AWS, producción SES: 1–5 días de espera).

---

## 1. Estado actual de Formularios

### 1.1 Schema (migraciones 0006, 0014, 0019)
| Tabla | Columnas relevantes | Notas |
|---|---|---|
| `forms` | `slug` UNIQUE, `name`, `status` (`draft/published/unpublished/archived`), `success_message`, `consent_text`, `opens_at`, `closes_at`, `identification_policy` jsonb (`matchFields`), `update_policy` (`fill_empty_only`/`always_flag_for_review`), `published_version`, `owner_organization_id` NOT NULL, `created_by` | **Sin** campaña, reunión ni descripción |
| `form_versions` | `(form_id, version)` UNIQUE, `schema` jsonb | Snapshot inmutable al publicar |
| `form_fields` | `key`, `label`, `field_type` (`text, textarea, dni, phone, email, number, date, select, radio, checkbox, association`), `options`, `required`, `visible`, `sort_order`, `person_field_mapping` | Sin `multiselect`, sin descripción/validación propia por campo |
| `form_actions` | `action_type` (solo `add_to_association`), `config` | |
| `form_submissions` | `raw_payload` (inmutable), `normalized_values`, `match_result` (`pending/created/matched/needs_review/error`), `person_id`, `idempotency_key` UNIQUE, `ip_address`, `user_agent`, `error_message`, `processed_at` | Sin origen (`public`/`csv`), sin archivo/fila fuente |
| `person_duplicate_candidates` | `person_id`, `submission_id`, `match_reason`, `status` (`pending/linked/created_new/discarded`) | Bandeja de revisión |
Grants: la app tiene `SELECT/INSERT/UPDATE` sobre `forms`, `form_submissions`, `person_duplicate_candidates`; `INSERT/SELECT` sobre `form_versions`; `ALL` sobre `form_fields/form_actions`.

### 1.2 Código
`lib/forms/` (apply, commands, duplicates, export, matching, publish-rules, queries, schema, sensitive, submit, version-schema, field-types); rutas `/formularios` (lista, `[id]` con campos/acciones/publicación, `[id]/respuestas`, `revision`), `/api/formularios/[id]/export`, pública `/f/[slug]` (+ server action con `idempotencyKey`). Permisos: `forms.view/create/edit/publish/export_submissions/review_duplicates`. Tests: `forms.test.ts`, `forms-publish-dni.test.ts`, `sensitive-and-public.test.ts`.

### 1.3 Qué hace hoy un envío (y qué contradice el pedido)
Validación zod por campo → `form_submissions` (idempotente por `idempotency_key`, `ON CONFLICT DO NOTHING`) → `matchPerson` (DNI/email/teléfono normalizados, **sin fuzzy**, ambigüedad → revisión ✓) → si **no hay match y hay DNI válido: `createPersonFromSubmission` (crea persona, `origin='form'`)** ✗; si hay match único y `fill_empty_only`: **escribe email/teléfono/fecha/custom en la persona** ✗ (sin verificación del dato); acciones `add_to_association`. Una persona fuera del árbol de la unidad del formulario nunca se modifica (va a revisión ✓).

**Cumple ya:** idempotencia, rate limit en tabla, match inequívoco, ambigüedad a revisión, aislamiento por unidad, export con sensibles según permisos, consent_text.
**No cumple / falta:** vínculo campaña/reunión, respuestas sin vincular como bandeja propia, «Inscribir» explícito, importación CSV con provenance, estados `closed`, `multiselect`, estadísticas, política de creación de personas configurable.

---

## 2. Estado actual de Reuniones
| Pedido | Estado |
|---|---|
| Estados `draft → scheduled → in_progress → finished`, `cancelled` | **Existe**: `MEETING_TRANSITIONS` (+ `StatusActions` en UI); transiciones incoherentes rechazadas; `overdue_unclosed` es etiqueta derivada |
| Crear/editar (nombre, descripción, tipo, organización, fecha/hora, lugar, dirección, notas) | **Existe** (`CreateMeetingForm`, `MeetingInfoForm`; editable en draft/scheduled) |
| Campaña | **Falta en la UI**: `meetings.campaign_id` existe, pero no hay selector y **no hay alta/edición de campañas** (solo lectura: `lib/campaigns/queries.ts`; se crearon por importación) |
| Capacidad | **No existe** la columna |
| Invitar, respuestas, inscribir, inscribir aceptados, asistencia manual, revocar/restaurar, historial | **Existe** (B2–B4, `InvitationWizard`, `EnrollmentSection`, `/asistencia`) |
| QR / check-in / métricas en vivo | **Existe**: `/reuniones/[id]/asistencia` (`QrDisplay`, `LivePanel`, `RegenerateQrButton`), `/api/reuniones/[id]/qr|live`, `/reunion/checkin` |
| Cierre sin inferir ausencias | **Existe** (B3) |
| Formularios desde la reunión | **Falta** |
| Producción | 36 reuniones: 9 `draft`, 27 `finished`; ninguna `scheduled`/`in_progress` aún |
Performance del detalle (B7): una tanda de 7 lecturas en paralelo (`getMeetingById`, asociaciones, organizaciones, invitaciones, participantes, métricas…) con pool de 10; medido ~460 ms (campañas ~600 ms por concurrencia del pool, **no** regresión de B). Sin cambios especulativos.

---

## 3. Estado actual de Personas / tags
- **Scope y selección:** `applyFilters(actor, filter)` es el único resolvedor (alcance Master/Área/Repartición; sin organización solo Master). `/personas` ya tiene **selección por ids o «seleccionar los N resultados del filtro»** resuelta en el servidor (`listAllMatchingIds(actor, filter)`), usada por acciones masivas (`bulkSetActive`, `bulkAddMembers`). **Es exactamente el patrón que necesita mailing.**
- **Tags:** `tags` (global/local, `is_sensitive`, `is_controlled`), `person_tags` (con `removed_at`); filtro por tag en `/personas` con visibilidad por actor. Producción: **1 tag («abogado», global) con 175.162 personas**.
- **Email en personas:** 4.078 con email (todos `origin=import`); sin verificación ni consentimiento registrado.
- **Gaps para mailing:** no hay normalización/validación persistida de email, ni lista de supresión, ni baja.

---

## 4. Qué se reutiliza de B1–B5
| Pieza | Uso |
|---|---|
| `applyFilters` / `listAllMatchingIds` / `canAccessPerson` / `personInScope` | Resolución de audiencia y scope del snapshot |
| `enrollPerson` (B4) y sus reglas | «Inscribir» desde respuestas — **una sola lógica de inscripción** |
| `meeting_registration_events`, `meeting_invitations` + eventos | Cadena de provenance (mailing → formulario → inscripción → …) |
| `countsAsRealContact` + contrato Fase F (B5) | Se mantiene: **ningún evento de mailing es contacto**; test que impide escribir `communication:*` sigue vigente |
| `lib/people/timeline.ts` | Nueva categoría de línea (formulario / mailing) sin tocar la regla de contacto |
| `sanitizeFreeText`, `applyMasking` | Datos sensibles en listados/exports/eventos |
| `public_link_attempts` + `checkPublicLinkRateLimit` | Rate limit de formulario público y de baja |
| Patrón evento append-only (B2–B4) | Eventos de envío SES |
| `app_settings` | Configuración (`MAIL_DAILY_SEND_LIMIT`, ritmo) editable sin deploy |
| Framework de importación (`import_files/rows`, links) | Importación CSV de Google Forms con idempotencia/provenance |

---

## 5. Gaps (resumen)
**Formularios:** vínculo campaña/reunión · bandeja «Respuestas sin vincular» · «Inscribir» explícito · importación CSV · política de creación/actualización de personas · estado `closed` · `multiselect`/descripción/validación de campos · estadísticas · timeline de persona.
**Reuniones:** capacidad · selector/alta de campaña · formulario desde la reunión · UX móvil del QR (auditar) · el menú lateral fijo de 256 px no es responsive (pre-existente, toda la app).
**Mailing:** todo.
**Infra:** dominio · cuenta AWS · worker · cron/proceso.

---

## 6. Modelo de Formularios (propuesta)
- **Vocabulario de estado:** se reutiliza `draft/published/unpublished/archived`; la UI rotula `unpublished` como «Cerrado» (y `closes_at` cierra solo). Sin cambios de CHECK.
- **Vínculos (0043):** `forms.campaign_id` (FK `campaigns`), `forms.meeting_id` (FK `meetings`), `forms.description`, `forms.person_creation_policy` (`never` | `when_valid_dni`, **default `never`**), `forms.apply_data_policy` (`never` | `fill_empty_only`, **default `never`**), `forms.default_meeting_id` opcional para campañas con jornadas. Regla: un formulario con campaña y **sin** jornada elegida **nunca decide solo** a qué jornada inscribir.
- **Campos:** sumar `multiselect`, `description`, `validation` (jsonb: min/max/regex acotado) — `key` UNIQUE por formulario ya existe.
- **Envíos (0043):** `form_submissions.source` (`public|csv_import|manual`), `source_import_row_id` (FK `import_rows`), `link_status` derivable (`linked` = `person_id` no nulo; `unlinked`; `ambiguous` = candidatos). Se conserva `raw_payload` inmutable.
- **Respuesta → inscripción:** tabla `form_submission_enrollments` (`submission_id`, `participation_id`, `meeting_id`, `enrolled_by`, `enrolled_at`, UNIQUE `(submission_id, meeting_id)`, append-only). La inscripción se hace con **`enrollPerson` de B4** (canal `form`, que se agrega al vocabulario de B4 ampliando el CHECK `origin_channel` de `meeting_participations` y `meeting_registration_events`: ampliación, no cambia filas).
- **Reglas duras (tests):** completar un formulario **no** crea inscripción, participación, asistencia ni contacto; persona sin match queda **sin vincular** (no se inventa); ambiguo → revisión; nunca fuzzy.

---

## 7. Modelo de Mailing (propuesta)
Tablas (0044), todas con RLS (`sutecba_app_all`), `INSERT/SELECT/UPDATE` solo donde corresponde y eventos/suppressions **sin UPDATE/DELETE** donde son historial:

| Tabla | Propósito |
|---|---|
| `email_campaigns` | Campaña: `name`, `subject`, `preheader`, `from_name`, `from_email`, `reply_to`, `html_body`, `text_body`, `status` (`draft/ready/scheduled/sending/paused/completed/cancelled/failed`), `owner_organization_id`, `created_by`, `audience_spec` jsonb (regla original), `audience_frozen_at`, `daily_limit_snapshot`, `scheduled_at/started_at/finished_at`, `provider='ses'`, `configuration_set`, `kind` (`marketing`/`operational`), contadores derivados por vista |
| `email_campaign_recipients` | **Snapshot**: una fila por **(campaña, email normalizado)**; `email_normalized`, `email_snapshot`, `primary_person_id`, `status` (`pending/queued/sending/sent/delivered/bounced/complained/unsubscribed/failed/uncertain` o exclusión: `excluded_no_email/excluded_invalid/excluded_suppressed/excluded_duplicate`), `exclusion_reason`, `batch_no`, `scheduled_date`, `provider_message_id`, `send_attempts`, `claimed_by`, `lease_until`, timestamps `queued_at/sent_at/delivered_at/bounced_at/complained_at/unsubscribed_at/first_opened_at/first_clicked_at`, `error` |
| `email_campaign_recipient_people` | Personas que comparten ese email (conserva «quiénes eran») — `(recipient_id, person_id)` |
| `email_campaign_batches` | `campaign_id`, `batch_no`, `scheduled_date`, `size`, `status`, contadores |
| `email_events` | **Append-only**: `seq`, `recipient_id`, `campaign_id`, `event_type` (`send/delivery/bounce/complaint/reject/delay/open/click/unsubscribe/failed`), `bounce_type`, `occurred_at`, `provider_event_key` UNIQUE (idempotencia), `payload_min` jsonb sanitizado |
| `email_suppressions` | `email_normalized` UNIQUE, `reason` (`bounce/complaint/unsubscribe/manual/invalid`), `source_campaign_id`, `created_at`, `released_at/by` (liberación explícita auditada) |
| `email_daily_quota` | `day` (fecha Buenos Aires) PK, `reserved`, `sent`, `limit_snapshot` — **libro global atómico** |
No se guardan secretos ni cuerpos de respuesta del proveedor completos.

---

## 8. Esquema propuesto — ver §7 y §6; migraciones en §23.

## 9. Selección por persona / tag / filtro
Se reutiliza el contrato de `/personas`: la selección viaja como `{ mode: "ids", ids } | { mode: "filter", filter }`; la regla del filtro (incluido `tagIds`) viaja como **especificación**, no como ids. Botones nuevos en la barra de selección: **«Crear mailing con selección»**. Límite de `ids` explícitos: 2.000 (por encima, exige modo filtro/tag). La resolución es server-side con `applyFilters` (scope del actor): un restringido **no puede** incluir personas que no ve.

## 10. Snapshot
Al crear la campaña, en **una transacción** y **un solo `INSERT … SELECT`** set-based: se resuelve la audiencia (CTE con `applyFilters`), se normaliza email (`lower(btrim())`), se valida formato, se cruza con `email_suppressions` y se deduplica con `row_number() over (partition by email_normalized …)`. Quedan filas para **todas** las personas seleccionadas (con su motivo de exclusión) → la vista previa se lee del snapshot; congelar el universo es inmediato e independiente de cambios posteriores del tag. Sin N+1 (15.000 personas ≈ 1–3 sentencias).

## 11. Dedupe — regla canónica
1. Clave = `lower(btrim(email))`.
2. **Una fila de envío por (campaña, email)**; el resto de las personas con ese email se ligan en `email_campaign_recipient_people` y su estado es `excluded_duplicate` a nivel persona (se ven en el dashboard).
3. Persona principal = la de **menor id** (determinista); la personalización usa el nombre solo si **todas** las personas del grupo coinciden; si no, fallback neutro («Hola»).
4. Una baja/queja sobre ese email suprime **a todas** las personas que lo comparten.

## 12. Amazon SES
- **Identidad:** dominio verificado (DKIM Easy 2048, 3 CNAME) + `MAIL FROM` propio (subdominio, SPF alineado) + **DMARC** (`p=none` → `quarantine` tras observar). Sin dominio propio no se puede producir (ver D1).
- **Región:** una sola (`us-east-1` por costo/estabilidad o `sa-east-1` por latencia; irrelevante para volumen bajo). Sin hardcodear.
- **Sandbox vs producción:** el cliente consulta `GetAccount` (`ProductionAccessEnabled`, `SendQuota.Max24HourSend`, `MaxSendRate`, `SentLast24Hours`); en sandbox el sistema **solo permite emails de prueba verificados** y limita 200/día y 1/s. Muestra el estado en la UI de mailing.
- **Configuration Set** `crm-mailing`: eventos Send/Delivery/Bounce/Complaint/Reject/DeliveryDelay (+ Open/Click si se habilitan) → **SNS topic → SQS**.
- **Cumplimiento de remitentes masivos (Gmail/Yahoo):** SPF+DKIM+DMARC alineados, `List-Unsubscribe` + `List-Unsubscribe-Post` (RFC 8058, un clic), tasa de quejas < 0,3 % (objetivo < 0,1 %).
- **Credenciales:** usuario IAM de mínimo privilegio (`ses:SendEmail`/`SendRawEmail` sobre la identidad, `ses:GetAccount`, `sqs:ReceiveMessage/DeleteMessage` sobre la cola) en `.env` de la VPS (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, fuera del repo, permisos 600); sin IAM role porque la VPS no es AWS. Nada de secretos en logs.

## 13. Cuotas
`MAIL_DAILY_SEND_LIMIT` (default 15000) en `app_settings` + variable de entorno de respaldo; **ritmo** `MAIL_SEND_RATE_PER_SECOND` y `MAIL_MAX_CONCURRENCY`. `getRemainingDailyEmailQuota()` = `limit − reserved` del día Buenos Aires. **Reserva atómica** (`UPDATE email_daily_quota SET reserved = reserved + $n WHERE day = $d AND reserved + $n <= $limit RETURNING`), global entre campañas; si SES rechaza o falla antes de aceptar, se devuelve la reserva. Dos campañas simultáneas comparten el mismo tope por construcción. El día cambia a medianoche Argentina (`(now() at time zone 'America/Argentina/Buenos_Aires')::date`). Campañas > cuota se parten en lotes por día (28.000 → 15.000 + 13.000) y continúan solas.

## 14. Scheduler / worker
Infra auditada: VPS Hostinger Ubuntu 24.04, **PM2 corriendo `npm run start`**, nginx; sin cron ni workers; Postgres en Supabase (**60 conexiones máx., pool de la app = 10**).
**Propuesta:** segundo proceso PM2 `sutecba-mail-worker` (`scripts/mail-worker.ts`, bucle propio con `sleep`; **no** `setInterval` dentro de Next). Cada ciclo: (1) reclamar el siguiente lote con `FOR UPDATE SKIP LOCKED` + `lease_until` (si el worker muere, el lease vence y otro retoma); (2) reservar cuota; (3) enviar respetando el ritmo (token bucket) y la concurrencia; (4) persistir `provider_message_id`. El estado vive en PostgreSQL: un reinicio de la VPS no pierde la cola. Pool del worker acotado a 2–3 conexiones. Un segundo proceso (o el mismo) sondea SQS para eventos.

## 15. Eventos
Config Set → SNS → **SQS** (long polling 20 s, DLQ con 5 reintentos). Idempotencia: `provider_event_key` = hash(`mail.messageId`, `eventType`, `timestamp`, `destination`) con UNIQUE → un evento duplicado es no-op. Cada evento actualiza el estado del destinatario con **orden monotónico** (`delivered` nunca retrocede a `sent`) y escribe `email_events`. `open/click` son señales de marketing (con la salvedad de Apple MPP).

## 16. Suppression
`email_suppressions` propia (además de la de SES). **Hard bounce** y **complaint** suprimen automáticamente; **soft bounce**: tolerar hasta 3 en 7 días y recién ahí suprimir (`reason=bounce`, `soft_exhausted`); `Reject` por contenido no suprime. Una dirección suprimida **no entra** a campañas nuevas (queda `excluded_suppressed` en el snapshot); solo la libera una persona con permiso `mailing.manage_suppressions`, con motivo y auditoría.

## 17. Unsubscribe
Token **HMAC-SHA256** del `recipient_id` con secreto propio (`MAIL_TOKEN_SECRET`), sin tabla. URL pública `…/baja/<token>`: GET muestra confirmación (los escáneres de enlaces no dan de baja); **POST** (y el POST de un clic del header) ejecuta la baja: inserta suppression `unsubscribe` + evento, **idempotente**. Toda campaña incluye pie con baja y los headers `List-Unsubscribe`. Origen y fecha registrados.

## 18. Timeline de Persona
Nueva categoría visible **«Mailing»** (y **«Formularios»**) con **una línea por campaña por persona**: «Mailing «Elección Consejo» — Enviado · Entregado · Abierto · Click» con los timestamps en el detalle; rebote/queja/baja resaltados. `countsAsContact=false` siempre. **No** se escribe en `person_interactions` ni se tocan `countsAsRealContact`/semáforo (el test que prohíbe escritores de `communication:*` queda como guardia). El nombre/asunto de la campaña se muestra solo con `mailing.view`; sin él, «Mailing».

## 19. Permisos
Módulo nuevo `mailing` y permisos: `mailing.view`, `mailing.create`, `mailing.send`, `mailing.manage_templates`, `mailing.view_metrics`, `mailing.manage_suppressions`. No se reutiliza `meetings.manage_invitations`. Defaults propuestos: MASTER y ADMIN todos; OPERADOR `view/create/manage_templates`; LECTURA `view_metrics`. Se agregan al catálogo y se aplican con el seed (no migración).

## 20. Scope
La audiencia se resuelve con el alcance **del creador** y queda congelada en el snapshot (no se expande después). Una campaña es visible para quien tenga alcance sobre su `owner_organization_id` (Master global). Listados de destinatarios y exports: emails enmascarados sin `people.view_sensitive`; exportación exige permiso aparte.

## 21. Seguridad
- **XSS:** el HTML del template se **sanea en servidor** (lista blanca de etiquetas/atributos, sin `<script>`, sin `on*`, sin `javascript:`) y la vista previa va en `<iframe sandbox>` sin scripts; las variables se **escapan** al interpolar. Motor de variables propio con `{{nombre}}`, `{{apellido}}`, `{{nombre_completo}}`, `{{organizacion}}` y fallback; **sin evaluación** de expresiones.
- **Inyección de headers:** subject/from/reply-to validados (sin CR/LF); `from_email` restringido a identidades verificadas.
- **Datos sensibles:** nada de emails completos a usuarios sin `people.view_sensitive`; eventos y logs sin tokens completos ni secretos.
- **Formulario público:** rate limit en tabla, honeypot + tiempo mínimo, idempotencia, límite de tamaño.

## 22. Costos (SES, verificar precios vigentes)
| Volumen | Costo SES (US$ 0,10 / 1.000) |
|---|---|
| 15.000 emails | ≈ US$ 1,50 |
| 50.000 | ≈ US$ 5,00 |
| 100.000 | ≈ US$ 10,00 |
| 450.000 / mes | ≈ US$ 45,00 |
SNS/SQS entran en el nivel gratuito a este volumen; tracking, IP dedicada (≈ US$ 25/mes) y VDM son **opcionales y no se contratan**. El costo real hoy sería marginal (~4.000 emails mailables).

## 23. Migraciones (2)
**0043 — `forms_meetings_extension`** (aditiva, idempotente): `forms` (+ `campaign_id`, `meeting_id`, `description`, `person_creation_policy`, `apply_data_policy`, `default_meeting_id`); `form_fields` (+ `description`, `validation`, `field_type` ampliado con `multiselect`); `form_submissions` (+ `source`, `source_import_row_id`); `form_submission_enrollments` (append-only, RLS); `meetings` (+ `capacity`); ampliación del CHECK `origin_channel` (+ `form`) en `meeting_participations` y `meeting_registration_events`.
**0044 — `mailing_core`**: las 7 tablas de §7, índices (`(campaign_id, status)`, `(campaign_id, email_normalized)` UNIQUE, parcial de cola `WHERE status in ('pending','queued')` por `scheduled_date, batch_no`, `provider_event_key` UNIQUE, `email_normalized` UNIQUE en supresiones), triggers append-only, RLS y grants mínimos.
Sin backfill de datos históricos; compatibles con el runtime anterior (columnas nuevas con default/NULL).

## 24. Tests
**Formularios:** crear/publicar/cerrar/enviar, required/invalid, rate limit, idempotencia (doble envío), match DNI/email/teléfono, ambiguo, sin match (queda sin vincular), política de creación `never`, **no crea inscripción/participación/asistencia/contacto**, «Inscribir» con las reglas de B4, campaña multi-jornada exige elección, scope, importación CSV idempotente.
**Reuniones:** regresión B1–B5 completa (invitaciones, respuestas, inscripción, asistencia, métricas, historiales, scope, QR, finish sin ausencias) + capacidad + vínculo formulario.
**Mailing:** audiencia manual/tag/filtro/«todos los resultados», snapshot, dedupe, inválidos, suppressed, baja idempotente, hard/soft bounce, complaint, cuota 15.000, **dos campañas simultáneas**, worker reiniciado, reintentos, eventos duplicados, test email sin tocar destinatarios, **semáforo intacto**, timeline, scope, datos sensibles, XSS.
**PostgreSQL real (copia restaurada):** cuota global bajo concurrencia, claim con `SKIP LOCKED`, lease/restart, idempotencia de eventos, rollover de día Buenos Aires.

## 25. Performance (objetivos y método)
Medir en copia restaurada con 15.000 destinatarios sintéticos: resolución de audiencia, snapshot (objetivo < 5 s), preview, claim de un lote, dashboard (agregados sobre índices), procesamiento de eventos (lote de 100 por `INSERT … ON CONFLICT`). Sin N+1: inserciones y claims **set-based**.

## 26. Riesgos
1. **Sin dominio** (bloqueante). 2. **Cobertura de email 2,3 %** y calidad desconocida (sin verificación). 3. **Consentimiento desconocido** de una base importada → riesgo de quejas/reputación; arranque con calentamiento. 4. Sandbox/cuota de SES. 5. Conexiones limitadas (60 / pool 10): el worker debe ser frugal. 6. Apple MPP infla aperturas. 7. Ampliar el CHECK de B4 toca tablas históricas (solo vocabulario). 8. Un fallo del worker no debe duplicar envíos (diseño «incierto = no reintentar»). 9. Formularios que actualizan emails sin verificación contaminan la lista.

## 27. Plan por fases
| Fase | Contenido | Días |
|---|---|---|
| F1 | Cierre de Formularios: migración 0043, política de personas, vínculos, vocabulario, «sin vincular» (dominio + tests) | 5 |
| F2 | UI/flujo: detalle con estadísticas, bandeja sin vincular, «Inscribir», importación CSV, timeline «Formularios» | 7 |
| R1 | Reuniones: capacidad, selector/alta de campaña, formulario desde reunión, UX móvil QR, verificación de performance | 5 |
| M1 | Schema 0044 + dominio (campañas, estados, plantillas, saneamiento, variables) | 6 |
| M2 | Selección/audiencia: botones en `/personas`, snapshot, dedupe, preview | 5 |
| M3 | Cliente SES, cuota global, worker PM2, rate limit, test email | 6 |
| M4 | Eventos SQS, suppressions, baja pública, bounce/complaint | 5 |
| M5 | UI de campañas y métricas (dashboard, destinatarios, tasas) | 5 |
| M6 | Timeline de persona + ficha «campañas recibidas» | 2 |
| M7 | Performance, PostgreSQL real, ensayo, runbook AWS, producción | 5 |
Total ≈ **51 días hábiles** secuenciales; ≈ **42–46** con solapamiento razonable (F2/R1 y M1/M2). Aprobación independiente por fase, como en B.

## 28. Estimación y prerrequisitos externos (no son código)
Dominio y DNS (SPF/DKIM/DMARC/MAIL FROM) · certificado válido en la VPS (Let's Encrypt) · cuenta AWS + usuario IAM + identidad SES + Configuration Set + SNS/SQS · **solicitud de acceso a producción de SES** (revisión de AWS: 1–3 días hábiles, puede pedir caso de uso/lista de suscripción) · calentamiento gradual del dominio.

---

## DECISIONES QUE NECESITO DE VOS
1. **Dominio y remitente.** ¿Qué dominio usará SUTECBA para enviar (y para el enlace de baja y los formularios públicos), y quién puede crear los registros DNS? Sin esto no se puede pasar a producción con mailing.
2. **Consentimiento de la base.** Los ~4.000 emails vienen de importaciones sin consentimiento registrado. ¿Se autoriza enviar a toda esa base (con baja en cada mail), solo a quienes lo hayan aceptado (formularios nuevos), o se empieza con un grupo piloto chico (~500) para calentar el dominio? *Recomiendo piloto + escalado.*
3. **Formularios y personas.** ¿Un formulario público puede **crear personas nuevas** (hoy lo hace si trae DNI válido) y **completar email/teléfono** de personas existentes? *Recomiendo: por defecto no; queda en revisión y un operador aplica los datos explícitamente.*
4. **Tipos de mailing.** ¿Los mails operativos (p. ej. invitaciones a una reunión) y los de difusión se tratan igual frente a la baja, o los operativos pueden enviarse a quien se dio de baja de difusión? *Recomiendo respetar la baja en todo mailing masivo.*
5. **Aprobación de envíos.** ¿Cualquier usuario con `mailing.send` puede lanzar, o se exige una segunda aprobación (p. ej. > 1.000 destinatarios o a toda la base)?
6. **Aperturas/clicks.** ¿Se habilita el tracking de aperturas y clicks (señales indicativas, con implicancias de privacidad), o solo entregas/rebotes/bajas?
7. **Cuota inicial.** ¿Arrancamos con un tope menor que 15.000 (p. ej. 2.000/día) durante el calentamiento y subimos de a poco?
8. **Capacidad de reuniones.** ¿Un cupo agotado **bloquea** nuevas inscripciones o solo **avisa**?
9. **Cuenta AWS.** ¿Quién es titular y paga la cuenta de AWS, y se prefiere región `us-east-1` o `sa-east-1`?

Después de tus respuestas (en particular 1–3) arranco por F1. No se implementó nada.


---

# F1 — cierre estructural de Formularios (IMPLEMENTADO en local, sin commit)

Decisiones aprobadas que rigen F1: subdominio configurable por entorno (sin hardcodear); rollout gradual del mailing con cuota configurable
(`MAIL_DAILY_SEND_LIMIT`); formularios con `person_creation_policy = never` y `apply_data_policy = never` por defecto; completar un
formulario nunca inscribe; la baja aplica a todo mailing masivo; confirmación reforzada >1.000 destinatarios (sin segunda aprobación obligatoria,
modelo preparado); opens/clicks habilitados pero **nunca** contacto real; capacidad blanda; AWS institucional, región configurable.

## Migración 0043 `forms_links_and_provenance` (aditiva, idempotente, sin backfill)
- `forms`: `description`, `campaign_id`, `meeting_id`, `default_meeting_id`, `person_creation_policy` (`never`|`when_valid_dni`, default `never`),
  `apply_data_policy` (`never`|`fill_empty_only`, default `never`); CHECK: la jornada por defecto exige campaña y no convive con reunión fija.
  `update_policy` queda **deprecada** (no se lee; no se elimina).
- `form_fields`: `description`, `validation` (jsonb acotado: largos y rango). `multiselect` NO se agrega: `checkbox` ya es multi-opción
  (un booleano es un checkbox con una opción), evitando un tipo duplicado y tocar `person_field_definitions`.
- `form_submissions`: `source` (`public|csv_import|manual`), `source_import_row_id` (FK `import_rows`, para la importación CSV de F2),
  `match_result` admite `unlinked`; índices parciales de la bandeja «sin vincular».
- `form_submission_events` (**provenance append-only**, RLS, `SELECT/INSERT`): `auto_linked`, `auto_person_created`, `auto_data_applied`,
  `linked`, `person_created`, `data_applied`, `enrolled`. UNIQUE parcial `(submission_id, meeting_id)` para `enrolled`.
- `meetings.capacity` (CHECK > 0; capacidad **blanda**).
- B4: el CHECK `origin_channel` de `meeting_participations` y `meeting_registration_events` se **amplía** con `form` (solo vocabulario; ninguna fila cambia).

### ¿Hacía falta `form_submission_enrollments`? No.
La relación respuesta → inscripción se reconstruye con `form_submission_events` (`enrolled` + `participation_id` + `meeting_id`). **No guarda estado**:
la inscripción canónica sigue siendo `meeting_participations` (B4) y su historial `meeting_registration_events`. Anular/restaurar la inscripción no toca
la respuesta; repetir «Inscribir» no crea una segunda fila ni restaura una anulada.

## Dominio
- `lib/forms/submit.ts`: sin coincidencia → `unlinked` (no crea personas); coincidencia inequívoca y dentro de la unidad → vincula (`matched`) y **no**
  completa datos (salvo `fill_empty_only`, solo vacíos, con evento `auto_data_applied`); coincidencia por email/teléfono con **DNI distinto** → revisión; ambigua o
  de otra unidad → revisión. Las acciones `add_to_association` configuradas se siguen ejecutando al vincular (decisión explícita del diseñador del formulario).
- `lib/forms/submissions.ts` (acciones explícitas de un operador, cada una con su evento en la misma transacción): `linkSubmissionToPerson`,
  `createPersonFromUnlinkedSubmission`, `applySubmissionData` (vacíos por defecto; `overwrite` exige campos; nunca DNI ni nombre; antes/después), `enrollSubmissions`.
- `enrollSubmissions` reutiliza `enrollPerson` de B4 (canal interno `form`, no disponible en la carga manual): `registered_at` = momento del envío,
  `recorded_by` = operador, estados/fecha retroactiva/scope/idempotencia de B4. Campaña con jornadas: nunca decide sola (jornada por defecto configurada o elección explícita;
  debe pertenecer a la campaña). Advertencia de **capacidad blanda** sin bloquear.
- `lib/forms/queries.ts`: `listUnlinkedSubmissions` (scope por unidad del formulario, payload enmascarado sin `people.view_sensitive`), `listSubmissionEvents`
  (provenance, valores sensibles enmascarados), `unlinkedCount` en la lista.
- `lib/forms/field-types.ts`: validación acotada (`minLength/maxLength/min/max`); descripción de campo en el snapshot y en el formulario público.
- Se mantiene el B5: completar un formulario o inscribir desde una respuesta **no** crea `person_interactions` ni contacto real (test).

## Fuera de F1 (siguientes fases)
Pantallas operativas (bandeja «sin vincular», botón «Inscribir», estadísticas), importación CSV, campaña/reunión desde la reunión, timeline «Formularios», Mailing completo.


---

# Mailing MVP con Amazon SES (IMPLEMENTADO en local, sin commit)

Ver el runbook operativo en `docs/MAILING-SES-RUNBOOK.md`. Resumen técnico:

- **Migración 0044 `mailing_mvp`** (aditiva, idempotente): `mailing_senders`, `mailing_campaigns`, `mailing_campaign_batches`,
  `mailing_campaign_recipients`, `mailing_campaign_recipient_people`, `mailing_suppressions`, `mailing_events` (append-only),
  `mailing_daily_quota`, `mailing_worker_heartbeats`. RLS, sin DELETE para `sutecba_app`. **Prefijo `mailing_` y no `email_`**: la guarda
  `assertNoForeignFootprint` (lib/db/guards.ts) trata cualquier tabla `email_*` como huella de otro sistema y aborta migrate/seed.
- **Dominio**: `lib/mailing/*` — audiencia (AudienceSpec resuelto en servidor, snapshot set-based), campañas (borrador → lista → lanzada, pausa/
  reanudar/cancelar), remitentes, cuota global atómica, worker (`FOR UPDATE SKIP LOCKED`, lease, `send_unknown`), eventos SES (SQS), bajas
  firmadas (HMAC), plantillas con sanitizado de HTML y variables escapadas.
- **B5**: el mailing aparece en el timeline como UNA línea por campaña (categoría `mailing`, `countsAsContact = false`); nunca escribe
  interacciones ni mueve semáforo/«Último contacto»/«Última actividad».
- **Permisos** (módulo nuevo `mailing`): `mailing.view`, `.create`, `.send`, `.manage_senders`, `.view_metrics`, `.manage_suppressions`.
  ADMIN: todos. OPERADOR: view, create, view_metrics (prepara y prueba; NO lanza). LECTURA: view, view_metrics. REUNIONES: ninguno. **Decisión provisional, a revisar en la Fase C.**
