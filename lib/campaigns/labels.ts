import type { CampaignHistoricalCondition, CampaignStatus, CampaignType } from "../db/schema.js";

/** Textos de negocio de las campañas (sin claves internas). Puro: se puede usar en componentes de servidor y de cliente. */

export const CAMPAIGN_TYPE_LABEL: Record<CampaignType, string> = {
  vaccination: "Campaña de vacunación",
  ophthalmology: "Campaña oftalmológica",
  other: "Campaña",
};

const STATUS_LABEL: Record<CampaignStatus, string> = {
  draft: "Borrador",
  scheduled: "Programada",
  active: "En curso",
  finalized: "Finalizada",
  cancelled: "Cancelada",
};

const HISTORICAL_LABEL: Record<CampaignHistoricalCondition, string> = {
  imported_occurred: "Realizada (importada)",
  imported_undated: "Importada sin fecha",
};

/**
 * Estado a mostrar: el operativo cuando alguien lo gestionó; si no, la condición histórica de una campaña importada.
 * Son conceptos distintos: una campaña importada puede no tener estado operativo y aun así sabemos que ocurrió.
 */
export function campaignStatusLabel(c: { status: CampaignStatus | null; historicalCondition: CampaignHistoricalCondition | null }): string {
  if (c.status) return STATUS_LABEL[c.status];
  if (c.historicalCondition) return HISTORICAL_LABEL[c.historicalCondition];
  return "Sin estado";
}

/** «AAAA-MM-DD» → «dd/mm/aaaa» (sin pasar por Date: no hay corrimiento de día posible). */
export function formatDay(day: string | null): string {
  return day ? day.split("-").reverse().join("/") : "—";
}

/** Rango de fechas documentadas de las jornadas; sin fechas, «Sin fecha documentada» (nunca una fecha inventada). */
export function campaignDatesLabel(c: { dateFrom: string | null; dateTo: string | null }): string {
  if (!c.dateFrom) return "Sin fecha documentada";
  return c.dateTo && c.dateTo !== c.dateFrom ? `${formatDay(c.dateFrom)} – ${formatDay(c.dateTo)}` : formatDay(c.dateFrom);
}
