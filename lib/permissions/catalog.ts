/**
 * Única fuente de verdad del catálogo de módulos, permisos y roles (decisión
 * D5). El seed (scripts/seed.ts) sincroniza esto a las tablas `modules`,
 * `permissions` y `role_permissions`; el chequeo en runtime siempre es
 * `can(user, "people.export")`, nunca por nombre de rol.
 *
 * Todo permiso pertenece a un módulo (`permissions.module_key` es NOT NULL
 * desde la migración 0013). Habilitar un módulo no otorga permisos, y un
 * permiso no rige si su módulo está deshabilitado para el usuario.
 */
export const MODULES = [
  { key: "dashboard", name: "Dashboard", sortOrder: 10 },
  { key: "personas", name: "Personas", sortOrder: 20 },
  { key: "asociaciones", name: "Asociaciones", sortOrder: 30 },
  { key: "reuniones", name: "Reuniones", sortOrder: 40 },
  { key: "formularios", name: "Formularios", sortOrder: 50 },
  { key: "visualizacion", name: "Visualización", sortOrder: 60 },
  { key: "interacciones", name: "Interacciones", sortOrder: 70 },
  { key: "importaciones", name: "Importaciones", sortOrder: 80 },
  { key: "etiquetas", name: "Etiquetas", sortOrder: 90 },
  { key: "administracion", name: "Administración", sortOrder: 100 },
] as const;

export type ModuleKey = (typeof MODULES)[number]["key"];

export const PERMISSIONS = [
  { key: "dashboard.view", moduleKey: "dashboard", description: "Ver el dashboard operativo" },
  { key: "visualization.view", moduleKey: "visualizacion", description: "Ver el módulo de visualización/análisis" },
  { key: "people.view", moduleKey: "personas", description: "Ver el listado y la ficha de personas" },
  { key: "people.create", moduleKey: "personas", description: "Dar de alta personas" },
  { key: "people.edit", moduleKey: "personas", description: "Editar datos de personas" },
  { key: "people.deactivate", moduleKey: "personas", description: "Desactivar personas" },
  { key: "people.export", moduleKey: "personas", description: "Exportar personas a CSV" },
  { key: "people.view_sensitive", moduleKey: "personas", description: "Ver DNI/teléfono/email y etiquetas sensibles sin enmascarar" },
  { key: "people.transfer", moduleKey: "personas", description: "Trasladar personas entre reparticiones desde una repartición bajo alcance propio" },
  { key: "people.assign_organization", moduleKey: "personas", description: "Asignar la repartición inicial a una persona pendiente de clasificación" },
  { key: "organizations.manage", moduleKey: "administracion", description: "Administrar el catálogo y jerarquía de organismos" },
  { key: "users.manage", moduleKey: "administracion", description: "Administrar usuarios globalmente; reservado al MASTER_GLOBAL" },
  { key: "users.manage_scoped", moduleKey: "administracion", description: "Administrar usuarios únicamente dentro de los alcances propios" },
  { key: "scopes.manage", moduleKey: "administracion", description: "Administrar alcances organizativos dentro de los alcances propios" },
  { key: "associations.view", moduleKey: "asociaciones", description: "Ver asociaciones y sus miembros" },
  { key: "associations.create", moduleKey: "asociaciones", description: "Crear asociaciones" },
  { key: "associations.edit", moduleKey: "asociaciones", description: "Editar asociaciones" },
  { key: "associations.deactivate", moduleKey: "asociaciones", description: "Desactivar asociaciones" },
  { key: "associations.manage_members", moduleKey: "asociaciones", description: "Agregar/quitar miembros de una asociación" },
  { key: "meetings.view", moduleKey: "reuniones", description: "Ver reuniones" },
  { key: "meetings.create", moduleKey: "reuniones", description: "Crear reuniones" },
  { key: "meetings.edit", moduleKey: "reuniones", description: "Editar reuniones" },
  { key: "meetings.change_status", moduleKey: "reuniones", description: "Cambiar el estado de una reunión (iniciar/finalizar/cancelar)" },
  { key: "meetings.manage_invitations", moduleKey: "reuniones", description: "Generar y gestionar invitaciones" },
  { key: "meetings.attendance_manual", moduleKey: "reuniones", description: "Registrar/corregir asistencia manualmente" },
  { key: "forms.view", moduleKey: "formularios", description: "Ver formularios y sus respuestas" },
  { key: "forms.create", moduleKey: "formularios", description: "Crear formularios" },
  { key: "forms.edit", moduleKey: "formularios", description: "Editar formularios" },
  { key: "forms.publish", moduleKey: "formularios", description: "Publicar/despublicar/archivar formularios" },
  { key: "forms.export_submissions", moduleKey: "formularios", description: "Exportar respuestas de formularios" },
  { key: "forms.review_duplicates", moduleKey: "formularios", description: "Resolver candidatos a duplicado" },
  { key: "interactions.view", moduleKey: "interacciones", description: "Ver interacciones dentro del alcance organizativo" },
  { key: "interactions.create", moduleKey: "interacciones", description: "Registrar interacciones dentro del alcance organizativo" },
  { key: "interactions.edit", moduleKey: "interacciones", description: "Editar o anular interacciones dentro del alcance organizativo" },
  { key: "imports.view", moduleKey: "importaciones", description: "Ver lotes, archivos, filas e incidencias de importación autorizadas" },
  { key: "imports.run", moduleKey: "importaciones", description: "Crear y procesar importaciones dentro del alcance organizativo" },
  { key: "imports.review", moduleKey: "importaciones", description: "Revisar incidencias y coincidencias ambiguas de importaciones" },
  { key: "tags.view", moduleKey: "etiquetas", description: "Ver etiquetas de personas respetando alcance y sensibilidad" },
  { key: "tags.assign", moduleKey: "etiquetas", description: "Crear etiquetas libres locales y asignar o quitar etiquetas dentro del alcance propio" },
  { key: "tags.manage", moduleKey: "etiquetas", description: "Administrar el catálogo de etiquetas, incluidas etiquetas controladas" },
] as const satisfies ReadonlyArray<{
  key: string;
  moduleKey: ModuleKey;
  description: string;
}>;

export type PermissionKey = (typeof PERMISSIONS)[number]["key"];

const MODULE_BY_PERMISSION: ReadonlyMap<PermissionKey, ModuleKey> = new Map(
  PERMISSIONS.map((p) => [p.key, p.moduleKey] as [PermissionKey, ModuleKey])
);

/**
 * Módulo al que pertenece un permiso. Se deriva de PERMISSIONS (no hay un mapa
 * paralelo): es lo que usa `can()` para exigir permiso + módulo habilitado.
 */
export function moduleOfPermission(permission: PermissionKey): ModuleKey {
  const moduleKey = MODULE_BY_PERMISSION.get(permission);
  if (!moduleKey) throw new Error(`Permiso sin módulo en el catálogo: ${permission}`);
  return moduleKey;
}

export const ROLES = [
  { key: "MASTER_GLOBAL", name: "Master global" },
  { key: "ADMIN", name: "Administrador" },
  { key: "OPERADOR", name: "Operador" },
  { key: "REUNIONES", name: "Reuniones" },
  { key: "LECTURA", name: "Lectura" },
] as const;

export type RoleKey = (typeof ROLES)[number]["key"];

const ALL_PERMISSION_KEYS: PermissionKey[] = PERMISSIONS.map((p) => p.key);

// people.assign_organization: una persona sin unidad solo es visible para MASTER_GLOBAL hasta que se la
// clasifica, así que clasificarla es exclusivo de MASTER_GLOBAL. Un ADMIN no puede ver a esas personas ni
// (con el alta actual, que exige unidad) crearlas: el permiso le sería inutilizable.
const ADMIN_EXCLUDED: PermissionKey[] = [
  "organizations.manage",
  "users.manage",
  "people.assign_organization",
];

/**
 * ADMIN no administra roles, organismos ni usuarios de forma global (eso es de
 * MASTER_GLOBAL); administra usuarios y alcances solo dentro de los propios
 * (`users.manage_scoped`, `scopes.manage`). Las reglas de contención (no dar
 * más alcance, módulos ni permisos de los que uno tiene) las aplica el
 * servidor y la base, no este catálogo.
 */
export const ROLE_PERMISSIONS: Record<RoleKey, PermissionKey[]> = {
  MASTER_GLOBAL: [...ALL_PERMISSION_KEYS],
  ADMIN: ALL_PERMISSION_KEYS.filter((k) => !ADMIN_EXCLUDED.includes(k)),
  OPERADOR: [
    "dashboard.view",
    "visualization.view",
    "people.view",
    "people.create",
    "people.edit",
    "people.deactivate",
    "associations.view",
    "associations.create",
    "associations.edit",
    "associations.manage_members",
    "meetings.view",
    "meetings.create",
    "meetings.edit",
    "meetings.change_status",
    "meetings.manage_invitations",
    "meetings.attendance_manual",
    "forms.view",
    "forms.create",
    "forms.edit",
    "forms.publish",
    "forms.review_duplicates",
    "interactions.view",
    "interactions.create",
    "interactions.edit",
    "imports.view",
    "imports.run",
    "imports.review",
    "tags.view",
    "tags.assign",
  ],
  REUNIONES: [
    "dashboard.view",
    "meetings.view",
    "meetings.change_status",
    "meetings.manage_invitations",
    "meetings.attendance_manual",
  ],
  LECTURA: [
    "dashboard.view",
    "visualization.view",
    "people.view",
    "associations.view",
    "meetings.view",
    "forms.view",
    "interactions.view",
    "tags.view",
  ],
};
