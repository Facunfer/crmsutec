import type { TimelineCategory, TimelineEvent, TimelinePage } from "./timeline.js";

/** Evento listo para el cliente: fechas como ISO (el servidor ya aplicó alcance, permisos y sanitización). */
export interface ClientTimelineEvent extends Omit<TimelineEvent, "at" | "activityDate"> {
  at: string | null;
  activityDate: string | null;
}

export interface ClientTimelinePage {
  events: ClientTimelineEvent[];
  nextCursor: string | null;
  counts: Record<TimelineCategory, number>;
}

export function toClientPage(page: TimelinePage): ClientTimelinePage {
  return {
    events: page.events.map((e) => ({ ...e, at: e.at ? e.at.toISOString() : null, activityDate: e.activityDate ? e.activityDate.toISOString() : null })),
    nextCursor: page.nextCursor,
    counts: page.counts,
  };
}
