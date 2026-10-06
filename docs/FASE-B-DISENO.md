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

## 7. Migraciones previstas (desde 0037; aditivas, idempotentes, sin backfill ni inferencia)

- **0037 (B2)** — `invited_by`, `response_channel`, `response_recorded_by` en `meeting_invitations`.
- **0038 (B3)** — `meeting_attendance`: método `qr`/`invitation_link`, `identification`, `recorded_at`, `occurred_precision`, `revoked_*`; guard actualizado;
  índice por `person_id`; tabla `meeting_attendance_events` (solo inserción).
- **0039 (B4)** — `meeting_participations`: `registered_at` (NULL en lo histórico), `recorded_by`, `origin_channel`, anulación `voided_*` solo para inscripciones `standard`.
- No se endurece el CHECK de `participation_kind` (los tipos sobrantes `invited/attended/absent/approved/unknown` quedan intactos).

## 8. Subetapas (aprobación independiente para cada una)

1. **B1** — lectura/UI/conteos: módulo común de métricas, chips de hechos, copy de procedencia, optimización de round trips. Sin migraciones ni escrituras.
2. **B2** — metadata de invitación/respuesta (0037).
3. **B3** — asistencia, undo real, auditoría y check-in (0038).
4. **B4** — inscripción operativa (0039).
5. **B5** — timeline de Persona (actividad separada de contacto).
6. **B6** — cierre, performance y producción.

## 9. Riesgos

Mezclar `source_business_rule` con asistencia; confundir `legacy_reference` con contacto real; revocación mal propagada a interacciones;
triggers que bloqueen actualizaciones legítimas; concurrencia en el escaneo; pool de conexiones (10) al paralelizar lecturas.
