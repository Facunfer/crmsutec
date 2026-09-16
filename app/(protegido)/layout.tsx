import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/guard";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { logout } from "./actions";

export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  if (user.mustChangePassword) {
    redirect("/login/cambiar-contrasena");
  }

  return (
    <div className="flex min-h-screen bg-brand-50">
      <Sidebar user={user} />
      <div className="flex-1">
        <header className="flex items-center justify-between border-b border-brand-100 bg-white px-6 py-3">
          <span className="text-sm text-brand-500">
            {user.fullName} · {user.roleKey}
          </span>
          <form action={logout}>
            <button type="submit" className="text-sm text-brand-500 hover:text-brand-700">
              Salir
            </button>
          </form>
        </header>
        <main className="p-6">{children}</main>
      </div>
    </div>
  );
}
