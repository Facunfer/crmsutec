import { getProviderAccountStatus } from "@/lib/mailing/queries";
import { loadMailConfig, PROVIDER_LABEL, validateMailConfig } from "@/lib/mailing/config";

/** Estado honesto del proveedor de correo activo (MAIL_PROVIDER): configuración, Sandbox o producción. Nunca simula entregas. */
export async function SesBanner() {
  const config = loadMailConfig();
  const label = PROVIDER_LABEL[config.provider];
  const issues = validateMailConfig(config).filter((i) => i.blocking);
  const account = await getProviderAccountStatus();

  if (issues.length > 0) {
    return (
      <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        <strong>{label} no está configurado.</strong> Faltan: {issues.map((i) => i.key).join(", ")}. Se puede preparar y previsualizar, pero no enviar.
      </div>
    );
  }
  if (account.error) {
    return (
      <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        <strong>No se pudo consultar {label}</strong> ({account.error}). Revisá las credenciales y la configuración.
      </div>
    );
  }
  if (account.sandbox) {
    return (
      <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        <strong>{label} está en modo Sandbox.</strong> Solo se entrega a direcciones verificadas; el resto de los envíos va a fallar. Pedí el acceso de
        producción para enviar a toda la base.
      </div>
    );
  }
  return (
    <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900">
      {label} en producción · tope diario del CRM: {config.dailySendLimit.toLocaleString("es-AR")}
      {config.provider === "ses" && config.region ? ` · región ${config.region}` : ""}
    </div>
  );
}
