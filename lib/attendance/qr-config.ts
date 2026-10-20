/**
 * Configuración del secreto de los QR (hallazgo S7). Funciones puras sobre un objeto de entorno: no leen archivos, no importan la
 * base y no imprimen jamás el secreto (los mensajes dicen QUÉ falta, nunca el valor).
 *
 * `SUTECBA_QR_SECRET` firma los QR de acreditación y las sesiones de check-in. Si falta o es corto, un QR firmado con una clave
 * adivinable permitiría acreditar a cualquiera: por eso, con la acreditación por QR habilitada, es OBLIGATORIO y de al menos 32
 * caracteres (el mismo mínimo que ya valida `lib/db/env.ts`). Una instalación que NO usa QR lo declara de forma explícita con
 * `SUTECBA_QR_DISABLED=true` y arranca igual; el modo seguro por defecto es «QR habilitado».
 */

export const QR_SECRET_MIN_LENGTH = 32;

export type QrEnv = Readonly<Record<string, string | undefined>>;

export class QrConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QrConfigError";
  }
}

/** Opt-out explícito y literal: cualquier otro valor (incluso vacío o «1») deja el QR habilitado. */
export function isQrDisabled(env: QrEnv = process.env): boolean {
  return env.SUTECBA_QR_DISABLED === "true";
}

export type QrConfigStatus = { state: "disabled" } | { state: "ok" } | { state: "invalid"; reason: "missing" | "too_short" };

export function qrConfigStatus(env: QrEnv = process.env): QrConfigStatus {
  if (isQrDisabled(env)) return { state: "disabled" };
  const secret = env.SUTECBA_QR_SECRET;
  if (!secret) return { state: "invalid", reason: "missing" };
  if (secret.length < QR_SECRET_MIN_LENGTH) return { state: "invalid", reason: "too_short" };
  return { state: "ok" };
}

function describe(reason: "missing" | "too_short"): string {
  return reason === "missing"
    ? "falta SUTECBA_QR_SECRET"
    : `SUTECBA_QR_SECRET tiene menos de ${QR_SECRET_MIN_LENGTH} caracteres`;
}

/**
 * Secreto raíz para firmar/verificar. FALLA CERRADO en cualquier entorno: sin secreto válido no se firma ni se acepta nada (nunca
 * se cae a un valor por defecto). Con `SUTECBA_QR_DISABLED=true` tampoco se firma: el QR está apagado.
 */
export function getQrRootSecret(env: QrEnv = process.env): string {
  const status = qrConfigStatus(env);
  if (status.state === "disabled") throw new QrConfigError("La acreditación por QR está deshabilitada en esta instalación (SUTECBA_QR_DISABLED=true).");
  if (status.state === "invalid") {
    throw new QrConfigError(
      `Configuración de QR inválida: ${describe(status.reason)}. Generar con: node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
    );
  }
  return env.SUTECBA_QR_SECRET as string;
}

/**
 * Validación de ARRANQUE. En producción con el QR habilitado, un secreto ausente o corto hace FALLAR el hook de arranque (`instrumentation.ts`).
 * Comportamiento verificado con la build de Next 15.5: el error queda registrado en el log («Failed to prepare server … QrConfigError») y el proceso
 * SIGUE EN PIE pero TODAS las rutas responden 500; es decir, el sitio queda fuera de servicio de forma visible (falla cerrado) en lugar de descubrirse
 * con el primer asistente que escanee. PM2 lo seguirá mostrando «online»: por eso el despliegue exige el chequeo previo y una verificación HTTP posterior.
 * En los demás entornos solo se valida al usar el secreto (desarrollo y pruebas sin QR siguen arrancando).
 */
export function assertQrConfigAtBoot(env: QrEnv = process.env): void {
  if (env.SUTECBA_ENV !== "production") return;
  const status = qrConfigStatus(env);
  if (status.state !== "invalid") return;
  throw new QrConfigError(
    `No se puede iniciar en producción: ${describe(status.reason)}. Definirlo (≥${QR_SECRET_MIN_LENGTH} caracteres) o declarar SUTECBA_QR_DISABLED=true si esta instalación no usa QR.`
  );
}
