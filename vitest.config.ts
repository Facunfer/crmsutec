import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Igual que tsconfig (`@/*`): permite importar páginas, acciones y rutas de app/ en los tests.
  resolve: { alias: { "@": resolve(__dirname) } },
  // Next compila TSX con jsx=preserve; para renderizar componentes en tests se usa el runtime automático.
  esbuild: { jsx: "automatic" },
  test: {
    // Quita de process.env las URLs de Postgres que vengan de la shell: los tests
    // corren siempre sobre PGlite descartable, nunca sobre una base real.
    setupFiles: ["./tests/setup.ts"],
    // Cada test de integración levanta su propia instancia embebida de
    // PGlite (WASM Postgres) contra un directorio propio. Correr varios
    // archivos en paralelo saturaba la máquina y producía timeouts falsos
    // en beforeAll — se prefiere una corrida más lenta pero confiable.
    fileParallelism: false,
    hookTimeout: 30000,
    testTimeout: 20000,
  },
});
