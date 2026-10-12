import { assertServerOnly } from "../server-only.js";
import type { MailConfig } from "./config.js";
import type { MailProvider } from "./providers/types.js";
import {
  advanceCampaigns,
  heartbeat,
  pollEvents,
  pruneHeartbeats,
  recoverExpiredLeases,
  removeHeartbeat,
  runSendCycle,
  workerLog,
  type EventQueue,
} from "./worker.js";

assertServerOnly("lib/mailing/worker-loop.ts");

export interface WorkerLoopOptions {
  workerId: string;
  startedAt: Date;
  config: MailConfig;
  /** Claves de configuración bloqueantes: si hay alguna, el worker espera y NO envía. */
  blockingIssues: string[];
  queue: EventQueue | null;
  /** Se consulta antes de cada paso: al devolver true el worker deja de reclamar y sale. */
  isStopping: () => boolean;
  provider?: MailProvider;
  idleMs?: number;
  busyMs?: number;
  /** Cada cuántas vueltas se podan latidos viejos (best-effort). */
  pruneEvery?: number;
}

async function interruptibleSleep(ms: number, isStopping: () => boolean): Promise<void> {
  const end = Date.now() + ms;
  while (!isStopping() && Date.now() < end) await new Promise<void>((r) => setTimeout(r, Math.min(200, Math.max(end - Date.now(), 1))));
}

/**
 * Bucle del worker. APAGADO LIMPIO (SIGTERM/SIGINT → `isStopping()` = true):
 *  1. no reclama destinatarios nuevos (ni siquiera arranca otro ciclo);
 *  2. el ciclo EN VUELO termina de enviar lo que ya reclamó y persiste cada resultado (si no, quedaría en `sending` y pasaría a
 *     `send_unknown`);
 *  3. no consume más eventos de la cola (evita esperas largas);
 *  4. retira su latido (la UI ve «no activo» enseguida) y devuelve el control para que el proceso cierre la base y salga.
 * El ciclo más largo son `workerConcurrency * 4` envíos a `maxSendRate`: segundos, muy por debajo de `kill_timeout` (30 s).
 */
export async function runWorkerLoop(o: WorkerLoopOptions): Promise<{ cycles: number }> {
  const idleMs = o.idleMs ?? 5_000;
  const busyMs = o.busyMs ?? 250;
  const pruneEvery = o.pruneEvery ?? 60;
  const canSend = o.blockingIssues.length === 0;
  let cycles = 0;
  let lastEvents = { applied: 0, duplicate: 0, unmatched: 0, ignored: 0 };

  while (!o.isStopping()) {
    cycles += 1;
    let busy = false;
    try {
      const recovered = await recoverExpiredLeases();
      if (recovered > 0) workerLog("leases vencidos → send_unknown", { workerId: o.workerId, recovered });
      await advanceCampaigns();

      if (canSend && !o.isStopping()) {
        const stats = await runSendCycle(o.workerId, { config: o.config, provider: o.provider });
        busy = stats.claimed > 0;
        if (stats.claimed > 0) workerLog("ciclo de envío", { workerId: o.workerId, ...stats });
      }
      if (o.queue && !o.isStopping()) {
        lastEvents = await pollEvents(o.queue, 10);
        if (lastEvents.applied + lastEvents.duplicate + lastEvents.unmatched > 0) workerLog("eventos", { workerId: o.workerId, ...lastEvents });
      }
      if (!o.isStopping()) await heartbeat(o.workerId, o.startedAt, { issues: o.blockingIssues, lastEvents });
      // Mantenimiento barato y fuera de la ruta crítica de envío.
      if (cycles % pruneEvery === 0) {
        const pruned = await pruneHeartbeats();
        if (pruned > 0) workerLog("latidos viejos podados", { workerId: o.workerId, pruned });
      }
    } catch (err) {
      workerLog("error en el ciclo", { workerId: o.workerId, error: err instanceof Error ? err.name : "error" });
      await interruptibleSleep(idleMs, o.isStopping);
      continue;
    }
    await interruptibleSleep(busy ? busyMs : idleMs, o.isStopping);
  }

  await removeHeartbeat(o.workerId);
  return { cycles };
}
