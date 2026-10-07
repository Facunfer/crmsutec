# Fase B — Invitación, respuesta, inscripción, participación y asistencia

Diseño aprobado el 2026-10-05. Cada subetapa (B1…B6) requiere aprobación independiente. Este documento es la referencia;
lo que se implemente debe poder rastrearse a una sección de acá.

## 1. Principio

Cinco hechos distintos, independientes y no lineales. Ninguno implica a otro salvo por una regla explícita y derivada:

| Hecho | Qué afirma | Dónde vive |
|---|---|---|
| Invitación | Alguien invitó a la persona a la actividad | `meeting_invitations` |
| Respuesta | La persona invitada aceptó / rechazó / no respondió | `meeting_invitations.response_status` (`confirmed` = «Aceptó») |
| Inscripción | La persona quedó anotada | `meeting_participations` kind `registration` |
| Participación | La persona participó, con su base (`standard`, `legacy_initial_import`, `source_business_rule`) | `meeting_participations` kind `participated` / `attended` |
| Asistencia | Evidencia real de presencia (QR, enlace personal o registro manual) | `meeting_attendance` (vigente = no revocada) |

Reglas:

- invitación ≠ respuesta; respuesta afirmativa ≠ inscripción (solo una acción explícita del staff puede inscribir a quienes aceptaron);
  inscripción ≠ participación; participación ≠ asistencia.
- `source_business_rule` acredita participación, nunca asistencia. `legacy_initial_import` sigue siendo legacy. 52016 = `registration/standard`.
- Nunca se infiere asistencia desde formularios, participación, respuesta ni `meeting_invitations.attendance_status`.
- Nunca se inventa una fecha. Lo histórico no se convierte automáticamente.

## 2. Correcciones conceptuales (aprobadas)

### 2.1 Actividad / participación NO es contacto real
Se mantienen separados: **actividad, participación, asistencia, interacción/contacto**. El timeline de Persona mostrará la actividad
(invitación, respuesta, inscripción, participación, asistencia) como tal. El futuro «último contacto real» se alimentará
**exclusivamente** de hechos clasificados explícitamente como contacto:

- `legacy_reference` nunca es contacto real.
- `source_business_rule` nunca es contacto real por sí mismo.
- `registration` nunca es contacto real.
- Una participación con fecha real no es automáticamente contacto real.
- La asistencia comprobada se muestra como actividad/asistencia y NO altera «último contacto real» hasta definir qué se entiende por contacto.

> **Decisión abierta (no se toca en B1).** Hoy `syncParticipationInteractions` genera `person_interactions` desde participaciones legacy
> y asistencia, y esas interacciones alimentan el semáforo (1.120 interacciones en producción, de las cuales ≥ 959 son `legacy_reference`).
> Esa conducta es anterior a esta corrección. Su rediseño (clasificación explícita de qué es contacto) queda para la fase de
> «último contacto real»; B1 no modifica escrituras ni interacciones.

### 2.2 Asistió ⊆ Participó es una regla derivada
- `Asistieron` = personas con asistencia vigente (no revocada).
- `Participaron` = personas con `participated`/`attended` explícito **UNION** personas con asistencia vigente, `DISTINCT person_id`.
- Un check-in **no** crea otra fila física en `meeting_participations`. La asistencia conserva su propia procedencia y auditoría.

## 3. Conteos (todos `DISTINCT person_id`, dentro del alcance del usuario; las categorías solapadas no se suman)

Jornada / reunión (una persona tiene a lo sumo una invitación por reunión):

| Métrica | Definición |
|---|---|
| Invitados | personas con invitación vigente (no retirada) |
| Aceptaron | invitados con `response_status = confirmed` |
| Rechazaron | invitados con `declined` |
| Pendientes | invitados con `pending` (Aceptaron + Rechazaron + Pendientes = Invitados) |
| Inscriptos | personas con `registration` en esa jornada |
| Participaron | `participated`/`attended` en la jornada UNION asistencia vigente en la jornada |
| Asistieron | asistencia vigente en la jornada |

Campaña (unión del nivel campaña por `campaign_key` y de todas sus jornadas `meetings.campaign_id`): mismas definiciones. Como una
persona puede estar invitada a varias jornadas con respuestas distintas, su respuesta de campaña se resuelve así (partición disjunta):
**aceptó** si aceptó alguna; si no, **pendiente** si alguna sigue pendiente; si no, **rechazó** (todas rechazadas).

Disponibilidad (nunca un 0 que induzca a error):

- Invitaciones / respuestas: si la actividad no tiene ninguna invitación y no es una actividad gestionada por el sistema (`origin = manual`) → **No disponible**.
- Asistencia: si no hay ningún check-in y la actividad es importada (sin relevamiento de asistencia) → **Sin información**. En una reunión gestionada por el sistema, 0 es 0.
- Inscriptos y Participaron salen de los registros cargados: un 0 significa «sin registros cargados», no que la actividad no ocurrió.

`meeting_invitations.attendance_status` queda **deprecado**: ningún cálculo nuevo lo lee. La fuente canónica de asistencia es
`meeting_attendance` vigente. Hasta B3 no existe la revocación, por lo que toda fila es vigente (el fragmento SQL `ATTENDANCE_ACTIVE`
es el único lugar a cambiar cuando B3 agregue `revoked_at`).

## 4. Presentación

- No se muestra un «estado efectivo único». Cada persona muestra **hechos independientes** (chips): Invitada · Aceptó / Rechazó / Pendiente ·
  Inscripta · Participó (con su base) · Asistió.
- Procedencia en lenguaje humano («Participación histórica inicial», «Participación acreditada por regla de la fuente», «Inscripción según listado»,
  «Asistencia comprobada por QR/enlace/registro manual»). Los códigos técnicos (T15, F06, …) quedan detrás, como detalle (tooltip), nunca como texto principal.
- Históricos: campaña importada → «Realizada (importada)» / «Importada sin fecha», invitaciones «No disponible», asistencia «Sin información».

## 5. Asistencia, QR y campañas (B3)

- La asistencia pertenece siempre a una reunión/jornada, nunca a una campaña. Una campaña sin jornada no admite check-in hasta que exista una jornada.
- Idempotencia: `UNIQUE(meeting_id, person_id)` + `INSERT … ON CONFLICT DO NOTHING`; el segundo escaneo devuelve la fila existente.
- Hora real del servidor al escanear; en cargas manuales retroactivas, el día de la actividad con precisión `date_only` (sin hora inventada).
- Undo = **revocación auditable** (`revoked_at/by/reason` + evento en `meeting_attendance_events`), nunca DELETE ni modificar solo la invitación.
  Bug actual a resolver en B3: corregir a «ausente» deja la fila de `meeting_attendance`, así que el sistema sigue considerando presente a la persona.

## 6. Permisos y scope

Se preservan Master / Área / Repartición, personas sin organización fuera de scopes restringidos, `people.view_sensitive` y la visibilidad de
campañas/reuniones. No se implementa la Fase C de permisos; hasta entonces inscribir usa `meetings.manage_invitations` y registrar/revocar
asistencia usa `meetings.attendance_manual`, siempre con la persona dentro del alcance del usuario.

## 7. Migraciones (desde 0037; aditivas, idempotentes, sin backfill ni inferencia)

- **0037 (B2)** — metadata de invitación y respuesta en `meeting_invitations`: `invited_by`, `invitation_channel`, `response_channel`,
  `response_recorded_by`, `responded_at_precision`, `response_recorded_at` + constraints de coherencia (pendiente sin datos de respuesta;
  respondida con canal y fecha de registro; enlace público ⇒ sin usuario y exacto; canal de staff ⇒ operador; fecha desconocida solo por staff;
  `date_only` = medianoche de Buenos Aires; nunca una fecha de respuesta posterior al registro).
- **0038 (B2)** — `meeting_invitation_events`: historial append-only (eventos `invited`, `responded`, `response_changed`, `withdrawn`, `reinvited`),
  columnas relacionales, FK compuesta a la invitación, trigger append-only, RLS, SELECT/INSERT para la app.
- **0039 (B3)** — `meeting_attendance`: `identification`, `recorded_at`, `occurred_precision` (`exact_datetime` / `date_only` / `unknown`, esta última solo en carga
  manual y con `checked_in_at` NULL), revocación (`revoked_at/by`, `revoke_reason`), vocabularios (`method`: `qr` · `invitation_link` · `manual`; `identification`:
  `dni` · `email` · `phone` · `invitation_token`; el CHECK de `method` conserva los valores anteriores por compatibilidad), `UNIQUE(id, meeting_id, person_id)`,
  índice por `person_id` y guard reescrito (identidad inmutable; solo cambian la revocación y la hora de una asistencia manual).
- **0040 (B3)** — `meeting_attendance_events`: historial append-only (`checked_in`, `revoked`, `restored`, `corrected`), `seq`, FK compuesta, RLS, SELECT/INSERT para la app.
- **0041 (B4)** — `meeting_participations`: `registered_at` (NULL en lo histórico), `recorded_by`, `origin_channel`, anulación `voided_*` solo para inscripciones `standard`.
- No se endurece el CHECK de `participation_kind` (los tipos sobrantes `invited/attended/absent/approved/unknown` quedan intactos).

### 7.1 B2 — invitación y respuesta (reglas)

- **Canales.** `channel` (existente, `manual_link`) es la forma TÉCNICA de creación/entrega y no se reinterpreta. `invitation_channel` es el canal de
  COMUNICACIÓN (`whatsapp`, `email`, `sms`, `phone`, `in_person`, `other`; NULL = no registrado). Registrarlo NO significa que el CRM haya enviado algo.
  `response_channel` suma `public_link`; «cargada manualmente» no es un canal: es `response_recorded_by`. El canal vive en cada invitación (la tanda no lo guarda).
- **Respuesta directa vs staff.** Por el enlace: `response_recorded_by` NULL, `responded_at` exacto. Por un operador: `response_recorded_by` = usuario,
  `responded_at` exacto / solo el día / NULL (desconocida; nunca se inventa con `response_recorded_at`).
- **DB mantiene `confirmed`; la UI dice «Aceptó».**
- **Idempotencia.** Repetir la MISMA respuesta pública (doble clic, refresh, retry) es NO-OP: no cambia `responded_at` ni genera evento.
  `response_changed` con `from = to` está reservado a una corrección explícita de metadata (canal/fecha/precisión) hecha por staff.
- **Reinvitación.** Solo sobre una invitación retirada: una transacción con `FOR UPDATE` que registra `reinvited` (con el estado previo) y reinicia la fila
  (token nuevo, respuesta pendiente sin datos, retiro limpio). La historia queda en los eventos. `attendance_status` se reinicia como antes (campo deprecado; B3).
- **Permisos y alcance (temporal hasta la Fase C).** Invitar, retirar y registrar una respuesta exigen `meetings.manage_invitations` + acceso a la reunión +
  persona dentro del alcance. `listInvitations` filtra por persona en alcance; los nombres de usuarios internos (quién invitó / quién registró) solo se ven con ese permiso.

### 7.2 INVARIANTE DE INTEGRIDAD DEL HISTORIAL (B2)

> **Toda mutación de estado o de metadata semántica de `meeting_invitations` debe pasar exclusivamente por los comandos transaccionales del módulo de
> invitaciones** (`lib/meetings/invitations.ts` y `respondToInvitation` en `lib/meetings/public.ts`), **que actualizan el estado y registran su evento en la misma
> transacción, con la invitación bloqueada (`FOR UPDATE`).**

La base impone combinaciones imposibles (0037) y que el historial sea append-only (0038), pero NO impone que exista un evento por cada cambio. No hay triggers
que lo hagan (decisión: el contexto —canal, responsable— ya viene en los comandos). Un test sobre el código fuente es una defensa adicional, no una garantía.
Los escritores heredados de `attendance_status` (`commands.ts`, `manual.ts`, `checkin.ts`) solo tocan ese campo deprecado y se reemplazan en B3.

### 7.3 B3 — asistencia (reglas)

- **Fuente canónica:** `meeting_attendance`; vigente ⇔ `revoked_at IS NULL`. Nunca se borra. `meeting_invitations.attendance_status` quedó DEPRECADO: no se lee ni se escribe
  (0 usos runtime; la columna se retirará con una migración destructiva futura aprobada).
- **Check-in público (QR / enlace):** solo en reuniones `scheduled` o `in_progress` dentro de la ventana; `INSERT … ON CONFLICT (meeting_id, person_id) DO NOTHING` + evento
  `checked_in`; un reintento o una carrera dejan una fila y un evento. Sobre una asistencia **revocada** devuelve «ya procesada» y no la restaura.
- **Asistencia manual** (permiso temporal `meetings.attendance_manual` + acceso a la reunión + persona en alcance + motivo): en reuniones `in_progress` o `finished`; sin invitación
  previa (no se crea una artificial); en una reunión finalizada es una carga retroactiva y hay que indicar cuándo ocurrió (día y hora, solo el día o desconocida).
- **Revocar / restaurar / corregir:** actos administrativos con usuario y motivo obligatorios, estado + evento en una transacción con la fila bloqueada. `corrected` solo cambia
  la hora/precisión de una asistencia manual vigente.
- **Interacciones:** la asistencia NO crea ni modifica interacciones (Opción B). Qué cuenta como «último contacto real» se define en B5.
- **`finishMeeting`:** ya no crea ausencias. Falta de check-in = «Sin asistencia registrada» (actividad gestionada) o «Sin información» (histórico/importado). No existe el hecho «No asistió».
- **Alcance estricto:** panel, búsquedas, carga manual, revocación, restauración, corrección e historial respetan el alcance ACTUAL de la persona. Master conserva la vista global.
- **Invariante de integridad (aplicación):** ver `lib/attendance/events.ts`.

## 8. Subetapas (aprobación independiente para cada una)

1. **B1** — lectura/UI/conteos: módulo común de métricas, chips de hechos, copy de procedencia, optimización de round trips. Sin migraciones ni escrituras.
2. **B2** — metadata de invitación/respuesta e historial (0037 + 0038).
3. **B3** — asistencia, undo real, auditoría y check-in (0039 + 0040).
4. **B4** — inscripción operativa (0041).
5. **B5** — timeline de Persona (actividad separada de contacto).
6. **B6** — cierre, performance y producción.

## 9. Riesgos

Mezclar `source_business_rule` con asistencia; confundir `legacy_reference` con contacto real; revocación mal propagada a interacciones;
triggers que bloqueen actualizaciones legítimas; concurrencia en el escaneo; pool de conexiones (10) al paralelizar lecturas.
