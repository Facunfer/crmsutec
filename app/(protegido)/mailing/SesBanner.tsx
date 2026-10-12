import { getProviderAccountStatus } from "@/lib/mailing/queries";
import { loadMailConfig, validateMailConfig } from "@/lib/mailing/config";

/** Estado honesto de Amazon SES: configuración, Sandbox o producción. Nunca simula entregas. */
export async function SesBanner() {
  const config = loadMailConfig();
  const issues = validateMailConfig(config).filter((i) => i.blocking);
  const account = await getProviderAccountStatus();

  if (issues.length > 0) {
    return (
      <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        <strong>Amazon SES no está configurado.</strong> Faltan: {issues.map((i) => i.key).join(", ")}. Se puede preparar y previsualizar, pero no enviar.
      </div>
    );
  }
  if (account.error) {
    return (
      <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        <strong>No se pudo consultar Amazon SES</strong> ({account.error}). Revisá las credenciales y la región.
      </div>
    );
  }
  if (account.sandbox) {
    return (
      <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        <strong>Amazon SES está en modo Sandbox.</strong> Solo se entrega a direcciones verificadas; el resto de los envíos va a fallar. Pedí el acceso de
        producción en AWS para enviar a toda la base.
      </div>
    );
  }
  return (
    <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900">
      Amazon SES en producción · tope diario del CRM: {config.dailySendLimit.toLocaleString("es-AR")} · región {config.region}
    </div>
  );
}
