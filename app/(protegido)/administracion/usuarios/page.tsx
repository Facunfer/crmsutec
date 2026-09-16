import { requirePermission } from "@/lib/auth/guard";
import { listUsers } from "@/lib/users/queries";
import { ROLES } from "@/lib/permissions/catalog";
import { CreateUserForm } from "./CreateUserForm";
import { UserRow } from "./UserRow";

export default async function UsuariosPage() {
  const actor = await requirePermission("users.manage");

  const users = await listUsers();
  const assignableRoles = ROLES.map((r) => r.key).filter(
    (key) => key !== "MASTER_GLOBAL" || actor.roleKey === "MASTER_GLOBAL"
  );

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-brand-900">Usuarios</h1>
      <CreateUserForm assignableRoles={assignableRoles} />

      <div className="rounded-lg bg-white p-4 shadow-sm">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-brand-100 text-xs uppercase tracking-wide text-brand-400">
              <th className="pb-2 font-medium">Usuario</th>
              <th className="pb-2 font-medium">Rol</th>
              <th className="pb-2 font-medium">Estado</th>
              <th className="pb-2 font-medium">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <UserRow
                key={user.id}
                user={user}
                isSelf={user.id === actor.id}
                assignableRoles={assignableRoles}
                canTouch={user.roleKey !== "MASTER_GLOBAL" || actor.roleKey === "MASTER_GLOBAL"}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
