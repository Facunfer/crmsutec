/**
 * Cómo mostrar cuándo ocurre una reunión. Las reuniones manuales siempre tienen fecha y hora
 * completas; las actividades importadas pueden tener solo el día (`date_only`) o ninguna fecha
 * (`pending`): nunca se muestra una fecha inventada.
 */
export function formatMeetingWhen(
  meeting: { startsAt: Date | null; endsAt: Date | null; schedulePrecision: "exact_datetime" | "date_only" | "unknown"; eventDate: Date | null },
  options: { withEnd?: boolean } = {}
): string {
  const tz = "America/Argentina/Buenos_Aires";
  if (meeting.startsAt) {
    const fmt = new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "short", timeZone: tz });
    const start = fmt.format(meeting.startsAt);
    return options.withEnd && meeting.endsAt ? `${start} – ${fmt.format(meeting.endsAt)}` : start;
  }
  if (meeting.schedulePrecision === "date_only" && meeting.eventDate) {
    // event_date es un `date` sin hora: se formatea en UTC para no correrlo de día.
    return new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeZone: "UTC" }).format(meeting.eventDate);
  }
  return "Fecha pendiente";
}
