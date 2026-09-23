import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { closeDb, getDb } from "../lib/db/client.js";
import { loadEnv, resolvePgliteDataDir } from "../lib/db/env.js";
import { activateMigrationConnection } from "../lib/db/script-env.js";
import {
  assertNoForeignFootprint,
  assertNotBlockedTarget,
  assertOrBootstrapSystemIdentity,
  describeTarget,
  GuardViolationError,
} from "../lib/db/guards.js";

function parseArg(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = argv.find((a) => a.startsWith(prefix));
  return found?.slice(prefix.length);
}

function generateStrongPassword(): string {
  return randomBytes(18).toString("base64url");
}

async function main() {
  const argv = process.argv.slice(2);
  const email = parseArg(argv, "email");
  const fullName = parseArg(argv, "name");
  const passwordArg = parseArg(argv, "password");

  if (!email || !fullName) {
    console.error(
      "Uso: npm run create-admin -- --email=alguien@sutecba.org.ar --name=\"Nombre Apellido\" [--password=...]"
    );
    process.exitCode = 1;
    return;
  }

  // Script administrativo: `sutecba_app` no ve sutecba_meta (reservada a la
  // conexión de migración), así que la guarda de identidad solo puede
  // verificarse con la conexión administrativa cuando existe.
  const usingAdminConnection = activateMigrationConnection();
  const env = loadEnv();
  const pgliteDataDir = resolvePgliteDataDir(env);
  console.log(
    `[create-admin] destino: ${describeTarget(env, pgliteDataDir)}` +
      (usingAdminConnection ? " (conexión de migraciones)" : "")
  );

  assertNotBlockedTarget(env, pgliteDataDir);
  const db = await getDb();
  await assertNoForeignFootprint(db);
  await assertOrBootstrapSystemIdentity(db);

  const role = await db
    .selectFrom("roles")
    .select("id")
    .where("key", "=", "MASTER_GLOBAL")
    .executeTakeFirst();
  if (!role) {
    throw new Error("Rol MASTER_GLOBAL no existe. Corré `npm run seed` primero.");
  }

  const existing = await db
    .selectFrom("users")
    .select("id")
    .where(({ fn }) => fn("lower", ["email"]), "=", email.toLowerCase())
    .executeTakeFirst();
  if (existing) {
    throw new Error(`Ya existe un usuario con ese email. No se crea uno nuevo.`);
  }

  const password = passwordArg ?? generateStrongPassword();
  const passwordHash = await bcrypt.hash(password, 12);

  await db
    .insertInto("users")
    .values({
      email: email.toLowerCase(),
      password_hash: passwordHash,
      full_name: fullName,
      role_id: role.id,
      status: "active",
      must_change_password: true,
    })
    .execute();

  console.log(`[create-admin] usuario MASTER_GLOBAL creado: ${email}`);
  if (!passwordArg) {
    console.log(
      `[create-admin] contraseña generada (se muestra UNA sola vez, no queda guardada en ningún lado): ${password}`
    );
  }
  console.log(`[create-admin] debe cambiar la contraseña en el primer ingreso.`);

  await closeDb();
}

main().catch((err) => {
  if (err instanceof GuardViolationError) {
    console.error(`[create-admin] ABORTADO por guarda: ${err.message}`);
  } else {
    console.error("[create-admin] error:", err);
  }
  process.exitCode = 1;
});
