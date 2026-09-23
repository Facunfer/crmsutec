import Link from "next/link";
import { can, type SessionUser } from "@/lib/permissions/can";
import type { PermissionKey } from "@/lib/permissions/catalog";

interface MenuItem {
  label: string;
  href: string;
  /** Alcanza con tener cualquiera de los permisos indicados. */
  permission: PermissionKey | PermissionKey[];
  built: boolean;
}

const MAIN_MENU: MenuItem[] = [
  { label: "Dashboard", href: "/dashboard", permission: "dashboard.view", built: true },
  { label: "Personas", href: "/personas", permission: "people.view", built: true },
  { label: "Asociaciones", href: "/asociaciones", permission: "associations.view", built: true },
  { label: "Reuniones", href: "/reuniones", permission: "meetings.view", built: true },
  { label: "Formularios", href: "/formularios", permission: "forms.view", built: true },
  { label: "Visualización", href: "/visualizacion", permission: "visualization.view", built: true },
];

const ADMIN_MENU: MenuItem[] = [
  { label: "Usuarios", href: "/administracion/usuarios", permission: ["users.manage", "users.manage_scoped"], built: true },
  { label: "Organismos", href: "/administracion/organismos", permission: "organizations.manage", built: true },
];

function isVisible(user: SessionUser, item: MenuItem): boolean {
  const required = Array.isArray(item.permission) ? item.permission : [item.permission];
  return required.some((permission) => can(user, permission));
}

function MenuLink({ item }: { item: MenuItem }) {
  if (!item.built) {
    return (
      <span
        title="No disponible todavía"
        className="flex cursor-not-allowed items-center justify-between rounded-md px-3 py-2 text-sm text-brand-300"
      >
        {item.label}
        <span className="text-[10px] uppercase tracking-wide">pronto</span>
      </span>
    );
  }
  return (
    <Link
      href={item.href}
      className="block rounded-md px-3 py-2 text-sm text-brand-900 hover:bg-brand-100"
    >
      {item.label}
    </Link>
  );
}

export function Sidebar({ user }: { user: SessionUser }) {
  const mainItems = MAIN_MENU.filter((item) => isVisible(user, item));
  const adminItems = ADMIN_MENU.filter((item) => isVisible(user, item));

  return (
    <nav className="w-64 shrink-0 border-r border-brand-100 bg-white p-4">
      <div className="mb-6 px-2 text-lg font-semibold text-brand-700">SUTECBA</div>
      <ul className="space-y-1">
        {mainItems.map((item) => (
          <li key={item.href}>
            <MenuLink item={item} />
          </li>
        ))}
      </ul>
      {adminItems.length > 0 ? (
        <>
          <div className="mb-1 mt-6 px-3 text-xs font-semibold uppercase tracking-wide text-brand-400">
            Administración
          </div>
          <ul className="space-y-1">
            {adminItems.map((item) => (
              <li key={item.href}>
                <MenuLink item={item} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </nav>
  );
}
