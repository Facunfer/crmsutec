"use server";

import { requirePermission } from "@/lib/auth/guard";
import { getPersonTimeline, isTimelineCategory, type TimelineCategory } from "@/lib/people/timeline";
import { toClientPage, type ClientTimelinePage } from "@/lib/people/timeline-client";

/** Página del timeline (filtro por categoría + cursor). Revalida el permiso y el alcance de la persona en cada llamada. */
export async function loadTimelineAction(personId: string, category: string | null, cursor: string | null): Promise<ClientTimelinePage | null> {
  const actor = await requirePermission("people.view");
  const categories: TimelineCategory[] = category && isTimelineCategory(category) ? [category] : [];
  const page = await getPersonTimeline(actor, personId, { categories, cursor, limit: 30 });
  return page ? toClientPage(page) : null;
}
