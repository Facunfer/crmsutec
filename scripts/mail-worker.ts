/**
 * Worker de Mailing (proceso PM2 aparte del `next start`). Lee la configuración del entorno / .env como la app, usa el rol de
 * runtime (SUTECBA_DATABASE_URL) y no expone ningún puerto.
 *
 * PM2 lo lanza directo con `node --import tsx scripts/mail-worker.ts` (un solo proceso: SIGTERM llega a este proceso, sin npm ni
 * wrappers). También sirve `npm run mail:worker` para correrlo a mano.
 *
 * APAGADO LIMPIO: SIGTERM/SIGINT → deja de reclamar, termina el ciclo en vuelo (persiste cada resultado), retira su latido, cierra la
 * base y sale (ver lib/mailing/worker-loop.ts). Si el proceso muere de golpe, el lease de lo reclamado vence y pasa a `send_unknown`:
 * nunca se reenvía solo.
 */
import { hostname } from "node:os";
import { closeDb } from "../lib/db/client.js";
import { loadEnv } from "../lib/db/env.js";
import { describeMailConfig, loadMailConfig, validateMailConfig } from "../lib/mailing/config.js";
import { createSqsEventQueue } from "../lib/mailing/sqs.js";
import { setWorkerLogger } from "../lib/mailing/worker.js";
import { runWorkerLoop } from "../lib/mailing/worker-loop.js";

function log(message: string, extra: Record<string, unknown> = {}): void {
  // Nunca se loguean secretos, tokens, cuerpos ni emails.
  console.log(JSON.stringify({ at: new Date().toISOString(), worker: "mail", message, ...extra }));
}

async function main() {
  loadEnv();
  const config = loadMailConfig();
  const issues = validateMailConfig(config);
  const blocking = issues.filter((i) => i.blocking).map((i) => i.key);
  const workerId = `${hostname()}:${process.pid}`;
  const startedAt = new Date();
  log("arranque", { workerId, config: describeMailConfig(config), issues: issues.map((i) => `${i.key}${i.blocking ? "!" : ""}`) });
  if (blocking.length > 0) log("configuración incompleta: el worker espera (no envía) hasta que se corrija y se reinicie");
  setWorkerLogger((message, fields) => log(message, fields));
  const queue = createSqsEventQueue();
  if (!queue) log("sin SES_EVENTS_QUEUE_URL: no se consumen eventos");

  let stopping = false;
  const stop = (signal: string) => {
    if (!stopping) log("señal de apagado recibida: no se reclama más y se termina el ciclo en vuelo", { workerId, signal });
    stopping = true;
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  const { cycles } = await runWorkerLoop({ workerId, startedAt, config, blockingIssues: blocking, queue, isStopping: () => stopping });
  log("detenido", { workerId, cycles });
  await closeDb();
}

main().catch(async (err) => {
  console.error("mail-worker: error fatal", err instanceof Error ? err.name : "error");
  await closeDb().catch(() => undefined);
  process.exit(1);
});
