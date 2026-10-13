/**
 * Contrato mínimo del proveedor de correo. Un solo proveedor en el MVP (Amazon SES); la interfaz existe para no acoplar la
 * aplicación al SDK ni a sus errores, no para soportar varios proveedores.
 */
export interface OutboundMessage {
  to: string;
  /** Ya formateado y a salvo de inyección de cabeceras (`"Nombre" <mail>`). */
  from: string;
  replyTo?: string | null;
  subject: string;
  html: string;
  text: string;
  /** Cabeceras extra (List-Unsubscribe, List-Unsubscribe-Post). */
  headers?: Record<string, string>;
  /** Etiquetas del proveedor para correlacionar eventos. */
  tags?: Record<string, string>;
}

/**
 * Resultado de un envío. LA DISTINCIÓN CRÍTICA ES `rejected` vs `unknown`:
 *  - accepted: el proveedor aceptó y devolvió un id de mensaje.
 *  - rejected: el proveedor respondió que NO envió (seguro): retryable indica si tiene sentido reintentar más tarde.
 *  - unknown : no sabemos si el proveedor aceptó (timeout, corte, 5xx). NUNCA se reintenta sola: requiere revisión humana.
 */
export type SendOutcome =
  | { kind: "accepted"; messageId: string }
  | { kind: "rejected"; code: string; message: string; retryable: boolean }
  | { kind: "unknown"; code: string; message: string };

export interface AccountStatus {
  /** true = el proveedor limita a destinatarios verificados. null = no se pudo determinar. */
  sandbox: boolean | null;
  sendingEnabled: boolean | null;
  max24HourSend: number | null;
  maxSendRate: number | null;
  sentLast24Hours: number | null;
  error?: string;
}

export type IdentityStatus = "pending" | "verified" | "failed" | "unknown";

/**
 * Resultado de consultar UNA identidad al proveedor, con lo necesario para explicárselo al operador.
 *  - verified / pending / failed: respuesta DEFINITIVA del proveedor (se persiste).
 *  - error: no se pudo consultar (permisos, red, región…): NO se toca el estado guardado y el error se muestra.
 */
export interface IdentityCheck {
  identity: string;
  region: string | null;
  outcome: "verified" | "pending" | "failed" | "error";
  /** Código del proveedor (NotFoundException, AccessDeniedException…) cuando lo hubo. */
  code?: string;
  /** Texto para el operador (sin credenciales). */
  message: string;
}

export interface MailProvider {
  readonly name: "ses";
  send(message: OutboundMessage, options?: { configurationSet?: string | null }): Promise<SendOutcome>;
  getAccountStatus(): Promise<AccountStatus>;
  getIdentityStatus(identity: string): Promise<IdentityStatus>;
  checkIdentity(identity: string): Promise<IdentityCheck>;
}
