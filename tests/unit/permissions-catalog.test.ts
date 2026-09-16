import { describe, expect, it } from "vitest";
import { PERMISSIONS, ROLE_PERMISSIONS, ROLES } from "../../lib/permissions/catalog.js";

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

  it("ADMIN tiene todo salvo roles.manage (sección 8: no puede editar roles)", () => {
    expect(ROLE_PERMISSIONS.ADMIN).not.toContain("roles.manage");
    expect(ROLE_PERMISSIONS.ADMIN.length).toBe(PERMISSIONS.length - 1);
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

  it("solo MASTER_GLOBAL puede administrar roles", () => {
    for (const role of ROLES) {
      if (role.key === "MASTER_GLOBAL") continue;
      expect(ROLE_PERMISSIONS[role.key]).not.toContain("roles.manage");
    }
  });
});
