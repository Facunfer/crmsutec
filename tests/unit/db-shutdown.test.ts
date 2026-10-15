import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Gancho de cierre de lib/db/client.ts. Regla: sin declaración explícita se comporta como siempre (cierra la base y sale, aunque
 * haya otros manejadores: es lo que necesita la app Next.js); con `deferProcessShutdownToApp()` NO cierra ni sale, y el proceso
 * (el worker de Mailing) decide cuándo hacerlo. La decisión no depende de contar listeners ni del orden de registro.
 */
describe("gancho de cierre de la base (cableado real, sin conectarse a ninguna base)", () => {
  const saved: Record<string, NodeJS.SignalsListener[]> = {};
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  let client: typeof import("../../lib/db/client.js");

  beforeAll(async () => {
    process.env.SUTECBA_ENV = "test";
    // URL ficticia: el pool de pg es perezoso, nunca llega a conectarse en este test.
    process.env.SUTECBA_DATABASE_URL = "postgresql://nadie:x@127.0.0.1:9/ninguna";
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      saved[sig] = process.listeners(sig) as NodeJS.SignalsListener[];
      process.removeAllListeners(sig);
    }
    client = await import("../../lib/db/client.js");
    await client.getDb(); // registra el gancho (una sola vez)
  });

  afterAll(async () => {
    await client?.closeDb();
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.removeAllListeners(sig);
      for (const l of saved[sig] ?? []) process.on(sig, l);
    }
    exitSpy.mockRestore();
  });

  const settle = () => new Promise((r) => setTimeout(r, 60));

  it("sin declaración explícita: cierra la base y sale, incluso con otro manejador presente (comportamiento de la app Next.js)", async () => {
    const other = vi.fn();
    process.on("SIGTERM", other);
    process.emit("SIGTERM");
    await settle();
    expect(other).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
    process.removeListener("SIGTERM", other);
    exitSpy.mockClear();
  });

  async function rearmHook() {
    // El gancho es `once` y se registra una sola vez: para repetir escenarios se vuelve a armar (sin tocar ninguna base real).
    (globalThis as unknown as Record<string, unknown>).__sutecbaShutdownHookRegistered = false;
    await client.closeDb();
    await client.getDb();
  }

  it("con apagado propio declarado: no cierra la base ni sale; la base sigue usable para terminar lo que esté en vuelo", async () => {
    client.deferProcessShutdownToApp();
    const own = vi.fn();
    process.on("SIGINT", own);
    process.emit("SIGINT");
    await settle();
    expect(own).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
    // la conexión sigue viva: el proceso todavía puede persistir resultados antes de cerrar
    const db = await client.getDb();
    expect(db).toBeTruthy();
    process.removeListener("SIGINT", own);
  });

  it("installWorkerShutdown: SIGTERM y SIGINT solo marcan «deteniéndose»; dispose() quita los manejadores y devuelve la señal al gancho", async () => {
    const { installWorkerShutdown } = await import("../../lib/mailing/worker-shutdown.js");
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      await rearmHook();
      exitSpy.mockClear();
      const baseline = new Set<unknown>(process.listeners(signal));
      const seen: string[] = [];
      const handle = installWorkerShutdown((s) => seen.push(s));
      expect(process.listeners(signal).filter((l) => !baseline.has(l))).toHaveLength(1); // se instaló exactamente uno
      expect(handle.isStopping()).toBe(false);

      process.emit(signal);
      await settle();
      expect(handle.isStopping()).toBe(true);
      expect(seen).toEqual([signal]); // se avisa una sola vez
      process.emit(signal);
      expect(seen).toEqual([signal]);
      expect(exitSpy).not.toHaveBeenCalled(); // el gancho de la base no cortó el proceso

      handle.dispose();
      expect(process.listeners(signal).filter((l) => !baseline.has(l))).toHaveLength(0); // ningún manejador propio queda registrado

      // revocado el compromiso, la señal vuelve a tener dueño: cierra la base y sale
      await rearmHook();
      process.emit(signal);
      await settle();
      expect(exitSpy).toHaveBeenCalledWith(0);
      exitSpy.mockClear();
    }
  });
});
