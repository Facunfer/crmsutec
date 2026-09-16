import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/guard";
import { ChangePasswordForm } from "./ChangePasswordForm";

export const metadata = { robots: "noindex, nofollow" };

export default async function CambiarContrasenaPage() {
  const user = await getSessionUser();
  if (!user) {
    redirect("/login?expirada=1");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-brand-50 px-4">
      <div className="w-full max-w-sm rounded-lg bg-white p-8 shadow-sm">
        <h1 className="mb-1 text-xl font-semibold text-brand-900">Cambiar contraseña</h1>
        <p className="mb-6 text-sm text-brand-500">
          {user.mustChangePassword
            ? "Tenés que cambiar tu contraseña antes de continuar."
            : "Actualizá tu contraseña."}
        </p>
        <ChangePasswordForm />
      </div>
    </main>
  );
}
