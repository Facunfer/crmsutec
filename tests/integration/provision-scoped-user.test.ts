import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_MODULE_KEYS } from "../helpers/modules.js";

process.env.SUTECBA_ENV = "test";
process.env.SUTECBA_PGLITE_DATA_DIR = `.data/pglite-test-${randomUUID()}`;

const { applyMigrations, parseFlags } = await import("../../scripts/migrate.js");
const { runSeed } = await import("../../scripts/seed.js");
const { closeDb, getDb } = await import("../../lib/db/client.js");
const { hashPassword, verifyPassword } = await import("../../lib/auth/passwords.js");
const { PERMISSIONS } = await import("../../lib/permissions/catalog.js");
const { provisionScopedUser, ProvisionError } = await import("../../lib/users/provision.js");
const { countPeople } = await import("../../lib/people/queries.js");

const dataDir = process.env.SUTECBA_PGLITE_DATA_DIR!;
const outDir = mkdtempSync(join(tmpdir(), "sutecba-cred-"));
const O: Record<string, string> = {};
let masterId: string;

beforeAll(async () => {
  await applyMigrations(parseFlags(["--allow-destructive"]));
  await runSeed();
  const db = await getDb();
  const type = async (key: string, level: number) => (await db.selectFrom("organization_types").select("id").where("key", "=", key).executeTakeFirst())?.id ?? (await db.insertInto("organization_types").values({ key, name: key, level } as never).returning("id").executeTakeFirstOrThrow()).id;
  const tMin = await type("ministerio", 1);
  const tSind = await type("sindicato", 0);
  const org = async (code: string, name: string, typeId: string, parent: string | null) => {
    O[code] = (await db.insertInto("organizations").values({ name, type_id: typeId, parent_id: parent, official_code: code }).returning("id").executeTakeFirstOrThrow()).id;
  };
  await org("MCGC", "Ministerio de Cultura", tMin, null);
  await org("EATC", "Teatro Colón", tMin, O.MCGC!);
  await org("MHFGC", "Ministerio de Hacienda", tMin, null);
  await org("SUTECBA", "Sindicato", tSind, null);
  const role = await db.selectFrom("roles").select("id").where("key", "=", "MASTER_GLOBAL").executeTakeFirstOrThrow();
  masterId = (await db.insertInto("users").values({ email: "prov-master@sutecba.local", password_hash: await hashPassword("x-password-123"), full_name: "M", role_id: role.id, status: "active" } as never).returning("id").executeTakeFirstOrThrow()).id;
  for (const [i, o] of [["1", "MCGC"], ["2", "EATC"], ["3", "MHFGC"]] as const) {
    await db.insertInto("people").values({ first_name: `P${i}`, last_name: "X", dni: `8000000${i}`, organization_id: O[o]!, origin: "manual" } as never).execute();
  }
});

afterAll(async () => {
  await closeDb();
  await new Promise((resolve) => setTimeout(resolve, 100));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(outDir, { recursive: true, force: true });
});

const base = (file: string, overrides: Record<string, unknown> = {}) => ({ createdBy: masterId, email: "cultura.test@sutecba.local", fullName: "Cultura Test", roleKey: "ADMIN", areaOfficialCode: "MCGC", credentialsFile: file, dryRun: false, ...overrides });

describe("alta del usuario de prueba de un Área", () => {
  const file = join(outDir, "usuario_cultura.txt");

  it("dry-run: comprueba y describe; no crea usuario ni archivo ni contraseña", async () => {
    const db = await getDb();
    const result = await provisionScopedUser(db, base(file, { dryRun: true }) as any);
    expect(result).toMatchObject({ mode: "dry-run", globalAccess: false, problems: [], area: { officialCode: "MCGC" } });
    expect(existsSync(file)).toBe(false);
    expect(await db.selectFrom("users").select("id").where("email", "=", "cultura.test@sutecba.local").executeTakeFirst()).toBeUndefined();
  });

  it("apply: ADMIN acotado a Cultura + descendientes, sin acceso global; la contraseña solo va al archivo", async () => {
    const db = await getDb();
    const result = await provisionScopedUser(db, base(file) as any);
    expect(result.mode).toBe("applied");

    const text = readFileSync(file, "utf-8");
    const password = /contraseña temporal: (\S+)/.exec(text)![1]!;
    expect(password.length).toBeGreaterThanOrEqual(20);
    expect(JSON.stringify(result)).not.toContain(password);
    const user = await db.selectFrom("users").selectAll().where("email", "=", "cultura.test@sutecba.local").executeTakeFirstOrThrow();
    expect(await verifyPassword(password, user.password_hash)).toBe(true);
    expect(user.must_change_password).toBe(true);
    expect(user.primary_organization_id).toBe(O.MCGC);
    const scopes = await db.selectFrom("user_scopes").select(["organization_id", "include_descendants"]).where("user_id", "=", user.id).where("revoked_at", "is", null).execute();
    expect(scopes).toEqual([{ organization_id: O.MCGC, include_descendants: true }]);
    const role = await db.selectFrom("roles").select("key").where("id", "=", user.role_id).executeTakeFirstOrThrow();
    expect(role.key).toBe("ADMIN");

    // Ve Cultura y sus descendientes; NO ve Hacienda.
    const actor: any = { id: user.id, email: user.email, fullName: "C", roleId: user.role_id, roleKey: "ADMIN", mustChangePassword: true, enabledModules: ALL_MODULE_KEYS, permissions: new Set(PERMISSIONS.map((p) => p.key)) };
    expect(await countPeople(actor, {})).toBe(2);
  });

  it("no sobrescribe un archivo existente ni crea un email repetido; el archivo debe quedar fuera del repositorio", async () => {
    const db = await getDb();
    await expect(provisionScopedUser(db, base(file, { email: "otro@sutecba.local" }) as any)).rejects.toThrow(/ya existe/);
    await expect(provisionScopedUser(db, base(join(outDir, "otro.txt")) as any)).rejects.toThrow(/Ya existe un usuario/);
    await expect(provisionScopedUser(db, base(join(process.cwd(), "credenciales.txt"), { email: "z@sutecba.local" }) as any)).rejects.toThrow(/FUERA del repositorio/);
  });

  it("rechaza SUTECBA como Área, un rol MASTER_GLOBAL y un actor que no es MASTER_GLOBAL", async () => {
    const db = await getDb();
    await expect(provisionScopedUser(db, base(join(outDir, "s.txt"), { email: "s@sutecba.local", areaOfficialCode: "SUTECBA" }) as any)).rejects.toThrow(/SUTECBA no es un Área/);
    await expect(provisionScopedUser(db, base(join(outDir, "m.txt"), { email: "m@sutecba.local", roleKey: "MASTER_GLOBAL" }) as any)).rejects.toBeInstanceOf(ProvisionError);
    await expect(provisionScopedUser(db, base(join(outDir, "a.txt"), { email: "a@sutecba.local", createdBy: randomUUID() }) as any)).rejects.toThrow(/no existe/);
    expect(existsSync(join(outDir, "s.txt"))).toBe(false);
  });
});
