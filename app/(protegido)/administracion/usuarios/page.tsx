import {
  getUserAccess,
  listAdministrableUsers,
  listAssignableRoles,
  listGrantableModules,
  listGrantableOrganizations,
  requireUserAdminPage,
} from "@/lib/users/administration";
import { listAreaOptions, listOrgTreeOptions } from "@/lib/organizations/areas";
import { AffiliationEditor } from "./AffiliationEditor";
import { CreateUserForm } from "./CreateUserForm";
import { UserAccessPanel } from "./UserAccessPanel";
import { UserRow } from "./UserRow";

export default async function UsuariosPage() {
  const { actor, mode } = await requireUserAdminPage();

  const [users, assignableRoles, organizations, modules] = await Promise.all([
    listAdministrableUsers(actor),
    listAssignableRoles(actor),
    listGrantableOrganizations(actor),
    listGrantableModules(actor),
  ]);
  const orgTree = await listOrgTreeOptions(actor);
  const areas = await listAreaOptions(actor, orgTree);
  const accessByUser = new Map(
    await Promise.all(users.map(async (user) => [user.id, await getUserAccess(user.id)] as const))
  );

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-brand-900">Usuarios</h1>
      <CreateUserForm
        assignableRoles={assignableRoles}
        areas={areas}
        orgTree={orgTree}
        modules={modules}
        requireScope={mode === "scoped"}
      />

      <div className="rounded-lg bg-white p-4 shadow-sm">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-brand-100 text-xs uppercase tracking-wide text-brand-400">
              <th className="pb-2 font-medium">Usuario</th>
              <th className="pb-2 font-medium">Área</th>
              <th className="pb-2 font-medium">Repartición</th>
              <th className="pb-2 font-medium">Rol</th>
              <th className="pb-2 font-medium">Estado</th>
              <th className="pb-2 font-medium">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const isSelf = user.id === actor.id;
              const canTouch = user.roleKey !== "MASTER_GLOBAL" || actor.roleKey === "MASTER_GLOBAL";
              return (
                <UserRow
                  key={user.id}
                  user={user}
                  isSelf={isSelf}
                  assignableRoles={assignableRoles}
                  canTouch={canTouch}
                  affiliation={
                    <AffiliationEditor
                      userId={user.id}
                      areas={areas}
                      orgTree={orgTree}
                      currentOrganizationId={user.primaryOrganizationId}
                      editable={!isSelf && canTouch}
                    />
                  }
                  access={
                    user.roleKey === "MASTER_GLOBAL" ? null : (
                      <UserAccessPanel
                        userId={user.id}
                        access={accessByUser.get(user.id)!}
                        organizations={organizations}
                        modules={modules}
                        editable={!isSelf && canTouch}
                      />
                    )
                  }
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
