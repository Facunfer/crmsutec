/**
 * Worker de Mailing (proceso PM2 aparte del `next start`). Lee la configuración del entorno / .env como la app, usa el rol de
 * runtime (SUTECBA_DATABASE_URL) y no expone ningún puerto.
 *
 *   npm run mail:worker
 *
 * Se detiene limpio con SIGTERM/SIGINT: termina el ciclo en curso (los destinatarios reclamados no quedan sueltos: si el proceso
 * muere en medio, su lease vence y pasan a `send_unknown`, nunca se reenvían solos).
 */
import { hostname } from "node:os";
import { closeDb } from "../lib/db/client.js";
import { loadEnv } from "../lib/db/env.js";
import { describeMailConfig, loadMailConfig, validateMailConfig } from "../lib/mailing/config.js";
import { createSqsEventQueue } from "../lib/mailing/sqs.js";
import { advanceCampaigns, heartbeat, pollEvents, recoverExpiredLeases, runSendCycle } from "../lib/mailing/worker.js";

const IDLE_MS = 5_000;
const BUSY_MS = 250;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function log(message: string, extra: Record<string, unknown> = {}): void {
  // Nunca se loguean secretos, tokens, cuerpos ni emails.
  console.log(JSON.stringify({ at: new Date().toISOString(), worker: "mail", message, ...extra }));
}

async function main() {
  loadEnv();
  const config = loadMailConfig();
  const issues = validateMailConfig(config);
  const workerId = `${hostname()}:${process.pid}`;
  const startedAt = new Date();
  log("arranque", { workerId, config: describeMailConfig(config), issues: issues.map((i) => `${i.key}${i.blocking ? "!" : ""}`) });
  if (issues.some((i) => i.blocking)) {
    log("configuración incompleta: el worker espera (no envía) hasta que se corrija y se reinicie");
  }
  const queue = createSqsEventQueue();
  if (!queue) log("sin SES_EVENTS_QUEUE_URL: no se consumen eventos");

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  let lastEvents = { applied: 0, duplicate: 0, unmatched: 0, ignored: 0 };
  while (!stopping) {
    let busy = false;
    try {
      const recovered = await recoverExpiredLeases();
      if (recovered > 0) log("leases vencidos → send_unknown", { recovered });
      await advanceCampaigns();

      if (!issues.some((i) => i.blocking)) {
        const stats = await runSendCycle(workerId, { config });
        busy = stats.claimed > 0;
        if (stats.claimed > 0) log("ciclo de envío", { ...stats });
      }
      if (queue) {
        lastEvents = await pollEvents(queue, 10);
        if (lastEvents.applied + lastEvents.duplicate + lastEvents.unmatched > 0) log("eventos", { ...lastEvents });
      }
      await heartbeat(workerId, startedAt, { issues: issues.filter((i) => i.blocking).map((i) => i.key), lastEvents });
    } catch (err) {
      log("error en el ciclo", { error: err instanceof Error ? err.name : "error" });
      await sleep(IDLE_MS);
    }
    await sleep(busy ? BUSY_MS : IDLE_MS);
  }
  log("detenido");
  await closeDb();
}

main().catch(async (err) => {
  console.error("mail-worker: error fatal", err instanceof Error ? err.name : "error");
  await closeDb().catch(() => undefined);
  process.exit(1);
});
