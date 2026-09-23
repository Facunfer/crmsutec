import { sql, type RawBuilder } from "kysely";

export const TRAFFIC_TIMEZONE = "America/Argentina/Buenos_Aires";
export const validInteraction = (alias = "pi") => sql`${sql.ref(`${alias}.status`)} in ('open', 'completed') and ${sql.ref(`${alias}.occurred_at`)} <= now()`;
export const interactionDay = (instant: RawBuilder<unknown>) => sql`(${instant} at time zone ${sql.lit(TRAFFIC_TIMEZONE)})::date`;
export const interactionAgeDays = (day: RawBuilder<unknown>) => sql`(${interactionDay(sql`now()`)} - ${day})::int`;
