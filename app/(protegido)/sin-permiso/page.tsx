import { requireUser } from "@/lib/auth/guard";

export default async function SinPermisoPage() {
  await requireUser();

  return (
    <div className="rounded-lg bg-white p-6 shadow-sm">
      <h1 className="mb-2 text-lg font-semibold text-brand-900">No tenés acceso a esta página</h1>
      <p className="text-sm text-brand-500">
        Tu usuario no tiene el permiso necesario. Si creés que deberías tenerlo, pedile a un
        administrador que revise tu rol.
      </p>
    </div>
  );
}
