import { describe, expect, it } from "vitest";
import { MODULES, PERMISSIONS, moduleOfPermission, type ModuleKey, type PermissionKey } from "../../lib/permissions/catalog.js";
import { can, hasModule, type SessionUser } from "../../lib/permissions/can.js";

function user(roleKey: string, permissions: PermissionKey[], modules: ModuleKey[]): SessionUser {
  return {
    id: "u",
    email: "u@sutecba.local",
    fullName: "U",
    roleId: "r",
    roleKey: roleKey as SessionUser["roleKey"],
    mustChangePassword: false,
    permissions: new Set(permissions),
    enabledModules: new Set(modules),
  };
}

const ALL_PERMISSIONS = PERMISSIONS.map((p) => p.key);
const ALL_MODULES = MODULES.map((m) => m.key);

// Matriz permiso → módulo tal como se definió (verificación independiente del catálogo).
const EXPECTED: Record<ModuleKey, string[]> = {
  dashboard: ["dashboard.view"],
  visualizacion: ["visualization.view"],
  personas: [
    "people.view",
    "people.create",
    "people.edit",
    "people.deactivate",
    "people.export",
    "people.view_sensitive",
    "people.transfer",
    "people.assign_organization",
  ],
  administracion: [
    "organizations.manage",
    "users.manage",
    "users.manage_scoped",
    "scopes.manage",
  ],
  asociaciones: [
    "associations.view",
    "associations.create",
    "associations.edit",
    "associations.deactivate",
    "associations.manage_members",
  ],
  reuniones: [
    "meetings.view",
    "meetings.create",
    "meetings.edit",
    "meetings.change_status",
    "meetings.manage_invitations",
    "meetings.attendance_manual",
  ],
  formularios: [
    "forms.view",
    "forms.create",
    "forms.edit",
    "forms.publish",
    "forms.export_submissions",
    "forms.review_duplicates",
  ],
  interacciones: ["interactions.view", "interactions.create", "interactions.edit"],
  importaciones: ["imports.view", "imports.run", "imports.review"],
  etiquetas: ["tags.view", "tags.assign", "tags.manage"],
};

describe("mapeo permiso → módulo (derivado de PERMISSIONS)", () => {
  it("todos los permisos del catálogo tienen módulo, y coincide con la matriz esperada", () => {
    const seen = new Set<string>();
    for (const [moduleKey, keys] of Object.entries(EXPECTED)) {
      for (const key of keys) {
        expect(moduleOfPermission(key as PermissionKey), key).toBe(moduleKey);
        seen.add(key);
      }
    }
    expect([...seen].sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it("todo módulo del catálogo tiene al menos un permiso", () => {
    for (const m of MODULES) {
      expect(EXPECTED[m.key].length, m.key).toBeGreaterThan(0);
    }
  });

  it("moduleOfPermission falla con un permiso desconocido", () => {
    expect(() => moduleOfPermission("no.existe" as PermissionKey)).toThrow();
  });
});

describe("can(): permiso + módulo habilitado", () => {
  it("MASTER_GLOBAL accede a todo sin módulos habilitados (bypass explícito)", () => {
    const master = user("MASTER_GLOBAL", ALL_PERMISSIONS, []);
    for (const key of ALL_PERMISSIONS) expect(can(master, key), key).toBe(true);
    for (const m of ALL_MODULES) expect(hasModule(master, m), m).toBe(true);
  });

  it("un usuario común con permiso + módulo accede", () => {
    const u = user("OPERADOR", ["forms.view"], ["formularios"]);
    expect(can(u, "forms.view")).toBe(true);
  });

  it("con el permiso pero sin el módulo, no accede (para cada permiso del catálogo)", () => {
    for (const p of PERMISSIONS) {
      const others = ALL_MODULES.filter((m) => m !== p.moduleKey);
      const u = user("ADMIN", [p.key], others);
      expect(can(u, p.key), `${p.key} sin módulo ${p.moduleKey}`).toBe(false);
    }
  });

  it("con el módulo pero sin el permiso, no accede (para cada permiso del catálogo)", () => {
    for (const p of PERMISSIONS) {
      const u = user("ADMIN", ALL_PERMISSIONS.filter((k) => k !== p.key), ALL_MODULES);
      expect(can(u, p.key), `${p.key} sin permiso`).toBe(false);
    }
  });

  it("habilitar un módulo no otorga permisos de otros módulos", () => {
    const u = user("ADMIN", ["forms.view", "people.view"], ["formularios"]);
    expect(can(u, "forms.view")).toBe(true);
    expect(can(u, "people.view")).toBe(false);
  });
});
