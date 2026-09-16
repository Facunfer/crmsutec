import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/guard";
import { LoginForm } from "./LoginForm";

export const metadata = { robots: "noindex, nofollow" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ expirada?: string }>;
}) {
  const user = await getSessionUser();
  if (user) {
    redirect("/dashboard");
  }

  const { expirada } = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center bg-brand-50 px-4">
      <div className="w-full max-w-sm rounded-lg bg-white p-8 shadow-sm">
        <h1 className="mb-1 text-xl font-semibold text-brand-900">CRM SUTECBA</h1>
        <p className="mb-6 text-sm text-brand-500">Ingresá con tu cuenta.</p>
        {expirada === "1" ? (
          <p className="mb-4 rounded-md bg-estado-alerta/10 px-3 py-2 text-sm text-estado-alerta">
            Tu sesión venció o no es válida. Iniciá sesión de nuevo.
          </p>
        ) : null}
        <LoginForm />
      </div>
    </main>
  );
}
