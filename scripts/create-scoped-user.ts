import { pathToFileURL } from "node:url";
import { closeDb, getDb } from "../lib/db/client.js";
import { loadEnv } from "../lib/db/env.js";
import { assertApplyEnvironment, assertUuid, ImportAbortError } from "../lib/imports/gabriel/preflight.js";
import { provisionScopedUser } from "../lib/users/provision.js";

/**
 * Alta de un usuario de prueba acotado a un Área (rol ADMIN por defecto, sin acceso global).
 *
 *   npm run user:create-scoped -- --email cultura.test@sutecba.local --name "Usuario de prueba Cultura" --area-code MCGC
 *       --credentials-file "C:\Users\usuario\Documents\sutecba-fuentes\credentials\usuario_cultura.txt"
 *       → DRY-RUN (solo lectura): comprueba y describe; no crea nada ni genera contraseña.
 *
 *   ... --apply --created-by <UUID MASTER_GLOBAL> --yes
 *       → crea el usuario con contraseña temporal fuerte, guardada SOLO en el archivo indicado (nunca se imprime).
 */
const NO_ACTOR = "00000000-0000-0000-0000-000000000000";

async function main() {
  const argv = process.argv.slice(2);
  const value = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i !== -1 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : undefined;
  };
  const required = (n: string): string => {
    const v = value(n);
    if (!v) throw new ImportAbortError(`Falta --${n}.`);
    return v;
  };
  const apply = argv.includes("--apply");
  const env = loadEnv();
  const db = await getDb();
  try {
    if (apply) assertApplyEnvironment({ env, yes: argv.includes("--yes") });
    // En dry-run el actor es opcional: sin él solo se informa que el alta exige un MASTER_GLOBAL.
    const createdBy = apply ? assertUuid(value("created-by"), "--created-by") : (value("created-by") ?? NO_ACTOR);
    const result = await provisionScopedUser(db, {
      createdBy,
      email: required("email"),
      fullName: value("name") ?? "Usuario de prueba",
      roleKey: value("role") ?? "ADMIN",
      areaOfficialCode: required("area-code"),
      includeDescendants: !argv.includes("--no-descendants"),
      credentialsFile: required("credentials-file"),
      dryRun: !apply,
    });
    console.log(JSON.stringify({ entorno: env.SUTECBA_ENV, ...result }, null, 2));
    if (!apply) console.log("[user:create-scoped] DRY-RUN: no se creó nada ni se generó ninguna contraseña.");
    else console.log("[user:create-scoped] Usuario creado. La contraseña temporal está SOLO en el archivo indicado (no se imprime).");
  } finally {
    await closeDb();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err: unknown) => {
    console.error(`[user:create-scoped] ${err instanceof ImportAbortError ? "ABORTADO" : "error"}: ${String((err as Error).message ?? err).replace(/postgres(ql)?:\/\/\S+/gi, "[url]")}`);
    process.exitCode = 1;
  });
}
