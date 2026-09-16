import { requirePermission } from "@/lib/auth/guard";
import { loadRolePermissionMatrix } from "@/lib/permissions/queries";

export default async function RolesPage() {
  await requirePermission("roles.manage");

  const { roles, permissions, grants } = await loadRolePermissionMatrix();

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-brand-900">Roles y permisos</h1>

      <div className="overflow-x-auto rounded-lg bg-white p-4 shadow-sm">
        <table className="min-w-full text-left text-sm">
          <thead>
            <tr className="border-b border-brand-100 text-xs uppercase tracking-wide text-brand-400">
              <th className="py-2 pr-4">Permiso</th>
              {roles.map((role) => (
                <th key={role.key} className="px-2 py-2 text-center font-medium">
                  {role.key}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {permissions.map((permission) => (
              <tr key={permission.key} className="border-b border-brand-50">
                <td className="py-1.5 pr-4">
                  <div className="font-mono text-xs text-brand-700">{permission.key}</div>
                  <div className="text-xs text-brand-400">{permission.description}</div>
                </td>
                {roles.map((role) => (
                  <td key={role.key} className="px-2 py-1.5 text-center">
                    {grants[`${role.key}:${permission.key}`] ? (
                      <span className="text-estado-ok">✓</span>
                    ) : (
                      <span className="text-brand-200">·</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
