/**
 * Única fuente de verdad del catálogo de permisos (decisión D5). El seed
 * sincroniza esto a la tabla `permissions`; el chequeo en runtime siempre
 * es `can(user, "people.export")`, nunca por nombre de rol.
 */
export const PERMISSIONS = [
  { key: "dashboard.view", description: "Ver el dashboard operativo" },
  { key: "visualization.view", description: "Ver el módulo de visualización/análisis" },

  { key: "people.view", description: "Ver el listado y la ficha de personas" },
  { key: "people.create", description: "Dar de alta personas" },
  { key: "people.edit", description: "Editar datos de personas" },
  { key: "people.deactivate", description: "Desactivar personas" },
  { key: "people.export", description: "Exportar personas a CSV" },
  { key: "people.view_sensitive", description: "Ver DNI/teléfono/email sin enmascarar" },
  { key: "people.manage_custom_fields", description: "Definir campos personalizados de personas (usados también por Formularios)" },

  { key: "organizations.manage", description: "Administrar el catálogo de organismos (tipos y jerarquía)" },

  { key: "associations.view", description: "Ver asociaciones y sus miembros" },
  { key: "associations.create", description: "Crear asociaciones" },
  { key: "associations.edit", description: "Editar asociaciones" },
  { key: "associations.deactivate", description: "Desactivar asociaciones" },
  { key: "associations.manage_members", description: "Agregar/quitar miembros de una asociación" },

  { key: "meetings.view", description: "Ver reuniones" },
  { key: "meetings.create", description: "Crear reuniones" },
  { key: "meetings.edit", description: "Editar reuniones" },
  { key: "meetings.change_status", description: "Cambiar el estado de una reunión (iniciar/finalizar/cancelar)" },
  { key: "meetings.manage_invitations", description: "Generar y gestionar invitaciones" },
  { key: "meetings.attendance_manual", description: "Registrar/corregir asistencia manualmente" },

  { key: "forms.view", description: "Ver formularios y sus respuestas" },
  { key: "forms.create", description: "Crear formularios" },
  { key: "forms.edit", description: "Editar formularios" },
  { key: "forms.publish", description: "Publicar/despublicar/archivar formularios" },
  { key: "forms.export_submissions", description: "Exportar respuestas de formularios" },
  { key: "forms.review_duplicates", description: "Resolver candidatos a duplicado" },

  { key: "users.manage", description: "Crear/editar/desactivar usuarios (no incluye rol MASTER_GLOBAL)" },
  { key: "roles.manage", description: "Editar la matriz de permisos de roles" },
  { key: "audit.view", description: "Ver el registro de auditoría" },
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number]["key"];

export const ROLES = [
  { key: "MASTER_GLOBAL", name: "Master global" },
  { key: "ADMIN", name: "Administrador" },
  { key: "OPERADOR", name: "Operador" },
  { key: "REUNIONES", name: "Reuniones" },
  { key: "LECTURA", name: "Lectura" },
] as const;

export type RoleKey = (typeof ROLES)[number]["key"];

const ALL_PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

const VIEW_ONLY: PermissionKey[] = [
  "dashboard.view",
  "visualization.view",
  "people.view",
  "associations.view",
  "meetings.view",
  "forms.view",
];

/**
 * ADMIN tiene "users.manage" pero el código de `lib/permissions` debe
 * impedir que lo use para crear/editar/desactivar un MASTER_GLOBAL o para
 * cambiarse el propio rol — eso no se resuelve con permisos granulares
 * sino con una regla de negocio explícita (ver Etapa 3).
 */
export const ROLE_PERMISSIONS: Record<RoleKey, PermissionKey[]> = {
  MASTER_GLOBAL: [...ALL_PERMISSION_KEYS],
  ADMIN: ALL_PERMISSION_KEYS.filter((k) => k !== "roles.manage"),
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
  ],
  REUNIONES: [
    "dashboard.view",
    "meetings.view",
    "meetings.change_status",
    "meetings.manage_invitations",
    "meetings.attendance_manual",
  ],
  LECTURA: VIEW_ONLY,
};
