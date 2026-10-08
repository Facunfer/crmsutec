import { sql, type RawBuilder } from "kysely";
import { assertServerOnly } from "../server-only.js";

assertServerOnly("lib/contacts/real-contact.ts");

/**
 * DEFINICIÓN CANÓNICA DE «CONTACTO REAL» (B5). Es la ÚNICA regla del CRM: semáforo, «Último contacto», ficha, /personas,
 * dashboard, analytics y exportación la usan desde acá (hay un test que escanea el código para que nadie arme otro filtro).
 *
 * Un contacto real es una comunicación o interacción EFECTIVA con la persona, registrada como `person_interactions` explícita:
 *   1. estado `completed` (una interacción abierta/planificada, cancelada o anulada NO es un contacto efectivo);
 *   2. ya ocurrió (`occurred_at <= now()`); la fecha de ocurrencia es la del contacto, nunca `created_at`;
 *   3. fecha REAL (`date_basis = 'actual'`): `legacy_reference` (fecha técnica 2026-01-01) jamás es contacto;
 *   4. ORIGEN PERMITIDO (lista blanca): carga manual (`source_key IS NULL`) o un namespace de comunicación reservado para la
 *      Fase F (`communication:*`). Cualquier otro origen NO cuenta hasta que se lo habilite expresamente acá;
 *   5. canal COMUNICACIONAL (presencial, teléfono, correo, WhatsApp, SMS): «formulario» y «otro» no prueban una comunicación;
 *   6. NO derivada de actividad: tipo `participation` o `source_key = meeting_participation:*` nunca es contacto.
 *
 * Nunca son contacto por sí solos: invitación, respuesta a una invitación (aunque sea por WhatsApp o enlace público), inscripción,
 * participación, asistencia, aparecer en una base, importación histórica, `source_business_rule`, `legacy_reference`,
 * pertenecer a una campaña, tener un tag. Tampoco un evento técnico.
 *
 * ⚠ ANTES DE HABILITAR CUALQUIER ESCRITURA `communication:*` (Fase F) HAY QUE REVISAR ESTA REGLA. Hoy nada escribe ese namespace (un test lo
 * verifica: si aparece un escritor, el test falla y obliga a revisar `countsAsRealContact` y su contrato). Los estados de comunicación/delivery
 * de la Fase F NO existen todavía y no se implementan en B5.
 *
 * CONTRATO PARA LA FASE F (no implementado): cuando existan estados de entrega, `sent`/`delivered`/`opened`/`clicked` son SEÑALES
 * de comunicación y NO implican por sí solos una conversación real; solo cuenta lo que el modelo final marque como contacto
 * efectivo (p. ej. saliente registrado por un operador, o respuesta/entrante de la persona). `failed`/`bounced`/`unsubscribed`
 * nunca son contacto. Una respuesta a invitación por enlace público jamás se convierte automáticamente en contacto.
 */

/**
 * Señales de comunicación/delivery que la Fase F podrá introducir y que NUNCA pueden contar automáticamente como contacto real. Esta lista
 * es solo el contrato: no hay estados de entrega en el schema. Antes de habilitar escrituras `communication:*` hay que decidir, con la
 * regla a la vista, qué estado final (saliente registrado por un operador, respuesta/entrante de la persona) constituye contacto efectivo.
 */
export const NEVER_AUTOMATIC_CONTACT_SIGNALS = ["sent", "delivered", "opened", "clicked", "failed", "bounced", "unsubscribed"] as const;

/** Canales que prueban una comunicación. `formulario` y `otro` quedan afuera a propósito. `sms` se agrega al catálogo en la Fase F. */
export const COMMUNICATION_CHANNEL_KEYS = ["presencial", "telefono", "correo", "whatsapp", "sms"] as const;
export type CommunicationChannelKey = (typeof COMMUNICATION_CHANNEL_KEYS)[number];

/** Tipo de interacción generado automáticamente desde una participación: nunca es contacto. */
export const PARTICIPATION_INTERACTION_TYPE_KEY = "participation";
/** Prefijo de source_key de las interacciones derivadas de una participación (el espejo técnico de «Participó»). */
export const PARTICIPATION_SOURCE_PREFIX = "meeting_participation:";
/** Namespace de source_key reservado para comunicaciones explícitas (Fase F). Lista blanca: solo este prefijo y NULL (manual). */
export const COMMUNICATION_SOURCE_PREFIX = "communication:";

/**
 * Condición SQL (booleana) «esta fila de person_interactions es un contacto real». `alias` es el alias de la tabla en la consulta
 * y es siempre un literal del código. Solo usa subconsultas NO correlacionadas sobre catálogos de 6 filas.
 */
export function countsAsRealContactSql(alias = "pi"): RawBuilder<boolean> {
  const col = (name: string) => sql.ref(`${alias}.${name}`);
  const channels = sql.join(COMMUNICATION_CHANNEL_KEYS.map((k) => sql.lit(k)));
  // La condición NUNCA es NULL (un canal nulo no puede volver NULL la regla ni, con `not`, excluir filas). Se mantiene como AND de
  // nivel superior para que el planner pueda probar que implica el predicado de un índice parcial.
  return sql<boolean>`(
    ${col("status")} = 'completed'
    and ${col("occurred_at")} <= now()
    and ${col("date_basis")} = 'actual'
    and (${col("source_key")} is null or ${col("source_key")} like ${sql.lit(COMMUNICATION_SOURCE_PREFIX + "%")})
    and coalesce(${col("channel_id")} in (select ic.id from interaction_channels ic where ic.key in (${channels})), false)
    and ${col("interaction_type_id")} not in (select it.id from interaction_types it where it.key = ${sql.lit(PARTICIPATION_INTERACTION_TYPE_KEY)})
  )`;
}

/** Condición SQL «es el espejo técnico de una participación» (no se muestra como línea del timeline: ya existe «Participó»). */
export function isParticipationDerivedSql(alias = "pi"): RawBuilder<boolean> {
  const col = (name: string) => sql.ref(`${alias}.${name}`);
  return sql<boolean>`(
    coalesce(${col("source_key")} like ${sql.lit(PARTICIPATION_SOURCE_PREFIX + "%")}, false)
    or ${col("interaction_type_id")} in (select it.id from interaction_types it where it.key = ${sql.lit(PARTICIPATION_INTERACTION_TYPE_KEY)})
  )`;
}

export interface InteractionFacts {
  status: string;
  occurredAt: Date;
  dateBasis: string;
  sourceKey: string | null;
  channelKey: string | null;
  typeKey: string;
}

/** Espejo TypeScript de `countsAsRealContactSql` (la suite verifica que ambas den siempre el mismo resultado). */
export function countsAsRealContact(i: InteractionFacts, now: Date = new Date()): boolean {
  return (
    i.status === "completed" &&
    i.occurredAt.getTime() <= now.getTime() &&
    i.dateBasis === "actual" &&
    (i.sourceKey === null || i.sourceKey.startsWith(COMMUNICATION_SOURCE_PREFIX)) &&
    i.channelKey !== null &&
    (COMMUNICATION_CHANNEL_KEYS as readonly string[]).includes(i.channelKey) &&
    i.typeKey !== PARTICIPATION_INTERACTION_TYPE_KEY
  );
}

/** Espejo TypeScript de `isParticipationDerivedSql`. */
export function isParticipationDerived(i: Pick<InteractionFacts, "sourceKey" | "typeKey">): boolean {
  return (i.sourceKey?.startsWith(PARTICIPATION_SOURCE_PREFIX) ?? false) || i.typeKey === PARTICIPATION_INTERACTION_TYPE_KEY;
}
