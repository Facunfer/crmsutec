import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Cada test de integración levanta su propia instancia embebida de
    // PGlite (WASM Postgres) contra un directorio propio. Correr varios
    // archivos en paralelo saturaba la máquina y producía timeouts falsos
    // en beforeAll — se prefiere una corrida más lenta pero confiable.
    fileParallelism: false,
    hookTimeout: 30000,
    testTimeout: 20000,
  },
});
