import { describe, expect, it } from "vitest";
import { MODULES, PERMISSIONS, ROLE_PERMISSIONS, ROLES } from "../../lib/permissions/catalog.js";

const PERMISSION_KEYS = new Set(PERMISSIONS.map((p) => p.key));

describe("catálogo de permisos (D5)", () => {
  it("todo permiso referenciado en ROLE_PERMISSIONS existe en PERMISSIONS", () => {
    for (const [roleKey, keys] of Object.entries(ROLE_PERMISSIONS)) {
      for (const key of keys) {
        expect(PERMISSION_KEYS.has(key), `${roleKey} referencia un permiso inexistente: ${key}`).toBe(
          true
        );
      }
    }
  });

  it("todo rol de ROLES tiene una entrada en ROLE_PERMISSIONS", () => {
    for (const role of ROLES) {
      expect(ROLE_PERMISSIONS[role.key]).toBeDefined();
    }
  });

  it("MASTER_GLOBAL tiene absolutamente todos los permisos", () => {
    expect(new Set(ROLE_PERMISSIONS.MASTER_GLOBAL)).toEqual(new Set(PERMISSION_KEYS));
  });

  it("ADMIN no administra organismos ni usuarios globales, pero sí usuarios y alcances propios", () => {
    for (const key of ["organizations.manage", "users.manage", "people.assign_organization"] as const) {
      expect(ROLE_PERMISSIONS.ADMIN).not.toContain(key);
    }
    expect(ROLE_PERMISSIONS.ADMIN).toContain("users.manage_scoped");
    expect(ROLE_PERMISSIONS.ADMIN).toContain("scopes.manage");
    expect(ROLE_PERMISSIONS.ADMIN.length).toBe(PERMISSIONS.length - 3);
  });

  it("LECTURA no tiene ningún permiso de creación, edición ni exportación", () => {
    const forbidden = ROLE_PERMISSIONS.LECTURA.filter((k) =>
      /\.(create|edit|deactivate|export|manage|publish|attendance_manual|manage_invitations|manage_members|change_status|view_sensitive|review_duplicates)$/.test(
        k
      )
    );
    expect(forbidden).toEqual([]);
  });

  it("REUNIONES no tiene permisos de personas/asociaciones/formularios", () => {
    const scoped = ROLE_PERMISSIONS.REUNIONES.filter(
      (k) => k.startsWith("people.") || k.startsWith("associations.") || k.startsWith("forms.")
    );
    expect(scoped).toEqual([]);
  });


  it("todo permiso tiene un moduleKey que existe en MODULES", () => {
    const moduleKeys = new Set<string>(MODULES.map((m) => m.key));
    for (const p of PERMISSIONS) {
      expect(moduleKeys.has(p.moduleKey), `${p.key} apunta a un módulo inexistente: ${p.moduleKey}`).toBe(true);
    }
  });

  it("no hay claves de módulo ni de permiso duplicadas", () => {
    const moduleKeys = MODULES.map((m) => m.key);
    expect(new Set(moduleKeys).size).toBe(moduleKeys.length);
    const permissionKeys = PERMISSIONS.map((p) => p.key);
    expect(new Set(permissionKeys).size).toBe(permissionKeys.length);
  });

  it("los 10 módulos esperados existen, con su orden", () => {
    expect(MODULES.map((m) => [m.key, m.sortOrder])).toEqual([
      ["dashboard", 10],
      ["personas", 20],
      ["asociaciones", 30],
      ["reuniones", 40],
      ["formularios", 50],
      ["visualizacion", 60],
      ["interacciones", 70],
      ["importaciones", 80],
      ["etiquetas", 90],
      ["administracion", 100],
    ]);
  });

  it("la clasificación inicial de personas sin unidad es exclusiva de MASTER_GLOBAL", () => {
    for (const role of ROLES) {
      if (role.key === "MASTER_GLOBAL") continue;
      expect(ROLE_PERMISSIONS[role.key], role.key).not.toContain("people.assign_organization");
    }
    expect(ROLE_PERMISSIONS.MASTER_GLOBAL).toContain("people.assign_organization");
  });

  it("OPERADOR no recibe los permisos reservados a ADMIN/MASTER", () => {
    for (const key of [
      "people.transfer",
      "people.assign_organization",
      "users.manage",
      "users.manage_scoped",
      "scopes.manage",
      "tags.manage",
      "organizations.manage",
    ] as const) {
      expect(ROLE_PERMISSIONS.OPERADOR).not.toContain(key);
    }
  });
});
