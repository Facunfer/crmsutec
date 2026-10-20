/**
 * Se ejecuta UNA vez al iniciar el servidor de Next (no en el build, no en el runtime edge). Si la validación falla, Next deja el proceso en pie
 * pero todas las rutas responden 500 (falla cerrado, visible en el log). Valida la configuración que no debe
 * descubrirse en el primer pedido: en producción, el secreto de los QR (S7). El worker de Mailing no pasa por acá.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { assertQrConfigAtBoot } = await import("@/lib/attendance/qr-config");
  assertQrConfigAtBoot();
}
