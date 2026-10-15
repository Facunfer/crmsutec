import { deferProcessShutdownToApp } from "../db/client.js";
import { assertServerOnly } from "../server-only.js";

assertServerOnly("lib/mailing/worker-shutdown.ts");

/**
 * Apagado ordenado del worker. Al recibir SIGINT/SIGTERM solo marca «deteniéndose»: el bucle deja de reclamar, el ciclo en vuelo
 * termina y persiste cada resultado, se retira el latido y recién entonces el proceso cierra la base y sale
 * (ver lib/mailing/worker-loop.ts y scripts/mail-worker.ts).
 *
 * Declara ANTES de cualquier acceso a la base que el proceso gestiona su propio apagado: así el gancho genérico de lib/db/client.ts
 * no cierra la base ni sale en medio de un envío.
 */
export function installWorkerShutdown(onSignal: (signal: NodeJS.Signals) => void): { isStopping: () => boolean; dispose: () => void } {
  const revokeDeferral = deferProcessShutdownToApp();
  let stopping = false;
  const installed = (["SIGINT", "SIGTERM"] as const).map((signal) => {
    const handler = () => {
      if (!stopping) onSignal(signal);
      stopping = true;
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  return {
    isStopping: () => stopping,
    dispose: () => {
      for (const [signal, handler] of installed) process.removeListener(signal, handler);
      // Sin manejadores propios, la señal vuelve a ser del gancho genérico (cierra la base y sale): nunca queda sin dueño.
      revokeDeferral();
    },
  };
}
