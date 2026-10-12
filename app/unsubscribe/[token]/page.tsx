import type { Metadata } from "next";
import { headers } from "next/headers";
import { previewUnsubscribe } from "@/lib/mailing/suppressions";
import { allowUnsubscribeAttempt } from "@/lib/mailing/unsubscribe-limit";

export const metadata: Metadata = {
  title: "Baja de comunicaciones",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

/**
 * Pública, sin sesión. El GET solo MUESTRA la confirmación (los antivirus y clientes de correo siguen enlaces automáticamente):
 * la baja se hace con el POST del botón. Idempotente. No revela el email completo.
 */
export default async function UnsubscribePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { token } = await params;
  const sp = await searchParams;
  const box = "mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center gap-4 px-4 text-center";
  const hdrs = await headers();
  if (!(await allowUnsubscribeAttempt(token, hdrs.get("x-forwarded-for")))) {
    return (
      <main className={box}>
        <p className="text-base text-brand-700">Demasiados intentos. Probá de nuevo en unos minutos.</p>
      </main>
    );
  }
  const preview = await previewUnsubscribe(token);

  if (!preview.valid) {
    return (
      <main className={box}>
        <p className="text-base text-brand-700">Este enlace no es válido o está incompleto.</p>
      </main>
    );
  }
  if (sp.listo === "1" || preview.alreadyUnsubscribed) {
    return (
      <main className={box}>
        <h1 className="text-lg font-semibold text-brand-900">Listo, ya no vas a recibir más comunicaciones.</h1>
        <p className="text-sm text-brand-600">La dirección {preview.maskedEmail} quedó dada de baja.</p>
      </main>
    );
  }
  return (
    <main className={box}>
      <h1 className="text-lg font-semibold text-brand-900">¿Querés dejar de recibir comunicaciones?</h1>
      <p className="text-sm text-brand-600">Vamos a dar de baja la dirección {preview.maskedEmail}. Esto aplica a todos los envíos masivos.</p>
      <form method="post" action={`/api/unsubscribe/${encodeURIComponent(token)}`}>
        <button type="submit" className="rounded-md bg-brand-600 px-4 py-2 text-white hover:bg-brand-700">
          Confirmar baja
        </button>
      </form>
    </main>
  );
}
