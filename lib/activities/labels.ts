/**
 * Métricas y hechos de una actividad (reunión/jornada o campaña). Puro y sin acceso a base: sirve en componentes de servidor y de cliente.
 *
 * Los cinco hechos son independientes (ver docs/FASE-B-DISENO.md): invitación, respuesta, inscripción, participación, asistencia.
 * Ninguna métrica suma categorías solapadas y ninguna se presenta como un único «estado efectivo».
 */

export type MetricValue = { kind: "value"; value: number } | { kind: "not_available" } | { kind: "no_information" };

export interface ActivityMetrics {
  invited: MetricValue;
  accepted: MetricValue;
  declined: MetricValue;
  pending: MetricValue;
  registered: MetricValue;
  participated: MetricValue;
  attended: MetricValue;
}

export type MetricKey = keyof ActivityMetrics;

export const METRIC_LABEL: Record<MetricKey, string> = {
  invited: "Invitados",
  accepted: "Aceptaron",
  declined: "Rechazaron",
  pending: "Pendientes",
  registered: "Inscriptos",
  participated: "Participaron",
  attended: "Asistieron",
};

export const METRIC_HINT: Record<MetricKey, string> = {
  invited: "Personas distintas con invitación vigente.",
  accepted: "Invitadas que aceptaron. Aceptar no inscribe ni implica asistencia.",
  declined: "Invitadas que rechazaron.",
  pending: "Invitadas que todavía no respondieron.",
  registered: "Personas distintas anotadas según los registros cargados. Inscribirse no implica participación ni asistencia.",
  participated: "Personas distintas con participación registrada o asistencia comprobada. 0 significa «sin registros cargados», no que la actividad no ocurrió.",
  attended: "Personas distintas con asistencia presencial comprobada (check-in real).",
};

export const METRIC_ORDER: MetricKey[] = ["invited", "accepted", "declined", "pending", "registered", "participated", "attended"];

export function metricText(m: MetricValue): string {
  if (m.kind === "value") return String(m.value);
  return m.kind === "not_available" ? "No disponible" : "Sin información";
}

/** Valor numérico o null (para tests y comparaciones). */
export function metricNumber(m: MetricValue): number | null {
  return m.kind === "value" ? m.value : null;
}

export interface RawMetricCounts {
  invited: number;
  accepted: number;
  declined: number;
  pending: number;
  registered: number;
  participated: number;
  attended: number;
  /** Hay al menos una invitación (incluso retirada) o la actividad se gestiona en el sistema (origin manual): las invitaciones se miden. */
  invitationsTracked: boolean;
  /** Hay al menos un check-in o la actividad se gestiona en el sistema: la asistencia se mide. */
  attendanceTracked: boolean;
}

/**
 * Regla de disponibilidad:
 *  - invitaciones/respuestas: sin invitaciones y actividad no gestionada por el sistema (importada) → «No disponible» (nunca 0);
 *  - asistencia: sin check-ins y actividad importada → «Sin información» (nunca 0);
 *  - inscriptos y participaron salen de los registros cargados y siempre son un número.
 */
export function buildMetrics(raw: RawMetricCounts): ActivityMetrics {
  const inv = (value: number): MetricValue => (raw.invitationsTracked ? { kind: "value", value } : { kind: "not_available" });
  return {
    invited: inv(raw.invited),
    accepted: inv(raw.accepted),
    declined: inv(raw.declined),
    pending: inv(raw.pending),
    registered: { kind: "value", value: raw.registered },
    participated: { kind: "value", value: raw.participated },
    attended: raw.attendanceTracked ? { kind: "value", value: raw.attended } : { kind: "no_information" },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Hechos de una persona en una actividad (chips independientes).
// ---------------------------------------------------------------------------------------------------------------------

export type ParticipationBasis = "standard" | "legacy_initial_import" | "source_business_rule";
export type InvitationResponse = "confirmed" | "declined" | "pending";

export interface PersonActivityFacts {
  invited: boolean;
  /** Respuesta de la invitación; null si no fue invitada. `confirmed` se muestra «Aceptó». */
  response: InvitationResponse | null;
  registered: boolean;
  /** Participación explícita registrada O asistencia comprobada (regla derivada: Asistió ⊆ Participó). */
  participated: boolean;
  /** Bases de las participaciones explícitas (no incluye la asistencia, que tiene su propia procedencia). */
  participationBases: ParticipationBasis[];
  /** Asistencia presencial comprobada vigente (meeting_attendance). */
  attended: boolean;
}

export interface FactChip {
  key: "invited" | "response" | "registered" | "participated" | "attended";
  label: string;
  tone: "neutral" | "positive" | "negative" | "info";
}

const RESPONSE_CHIP: Record<InvitationResponse, FactChip> = {
  confirmed: { key: "response", label: "Aceptó", tone: "positive" },
  declined: { key: "response", label: "Rechazó", tone: "negative" },
  pending: { key: "response", label: "Sin respuesta", tone: "neutral" },
};

/** Chips independientes en un orden fijo; nunca un único «estado efectivo». Lista vacía si no hay ningún hecho. */
export function factChips(f: PersonActivityFacts): FactChip[] {
  const chips: FactChip[] = [];
  if (f.invited) chips.push({ key: "invited", label: "Invitado", tone: "neutral" });
  if (f.invited && f.response) chips.push(RESPONSE_CHIP[f.response]);
  if (f.registered) chips.push({ key: "registered", label: "Inscripto", tone: "info" });
  if (f.participated) chips.push({ key: "participated", label: "Participó", tone: "positive" });
  if (f.attended) chips.push({ key: "attended", label: "Asistió", tone: "positive" });
  return chips;
}

export const BASIS_COPY: Record<ParticipationBasis, string> = {
  standard: "Participación registrada",
  legacy_initial_import: "Participación histórica inicial",
  source_business_rule: "Participación acreditada por regla de la fuente",
};

export const ATTENDANCE_METHOD_COPY: Record<string, string> = {
  invitation_token: "Asistencia comprobada con enlace personal",
  invitation_link: "Asistencia comprobada con enlace personal",
  qr: "Asistencia comprobada por QR",
  dni: "Asistencia comprobada por QR e identificación",
  email: "Asistencia comprobada por QR e identificación",
  phone: "Asistencia comprobada por QR e identificación",
  manual: "Asistencia registrada manualmente",
};

/**
 * Clasificación EXPLÍCITA de qué hechos de actividad cuentan como contacto real. Ninguno por ahora: el «último contacto real»
 * se definirá en su propia fase. Un test fija esta tabla para que nadie la cambie sin decidirlo.
 */
export const ACTIVITY_FACT_COUNTS_AS_CONTACT: Record<"invitation" | "response" | "registration" | "participation" | "attendance", false> = {
  invitation: false,
  response: false,
  registration: false,
  participation: false,
  attendance: false,
};
