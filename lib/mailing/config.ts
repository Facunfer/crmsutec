import { assertServerOnly } from "../server-only.js";
import { loadDotEnvFile } from "../db/env.js";

assertServerOnly("lib/mailing/config.ts");

/**
 * Configuración del Mailing leída SOLO de variables de entorno (nunca hardcodeada ni en la base). Los secretos no se imprimen:
 * `describeMailConfig()` devuelve solo banderas y valores no sensibles.
 */
export interface MailConfig {
  provider: "ses";
  region: string | null;
  /** Credenciales explícitas (si faltan, el SDK usa su cadena por defecto: rol de instancia, perfil, etc.). */
  hasExplicitCredentials: boolean;
  configurationSet: string | null;
  /** Tope diario GLOBAL de envíos (rollout gradual: 500 → 1.000 → … → 15.000). */
  dailySendLimit: number;
  /** Mensajes por segundo al proveedor. */
  maxSendRate: number;
  workerConcurrency: number;
  unsubscribeSecret: string | null;
  publicBaseUrl: string | null;
  eventsQueueUrl: string | null;
  costPer1000Usd: number;
  /** Segundos de lease de un destinatario en envío. */
  leaseSeconds: number;
  /** Destinatarios a partir de los cuales se exige confirmación reforzada. */
  reinforcedConfirmationThreshold: number;
  timezone: string;
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

function floatEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function strEnv(name: string): string | null {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : null;
}

export function loadMailConfig(): MailConfig {
  loadDotEnvFile();
  return {
    provider: "ses",
    region: strEnv("AWS_REGION") ?? strEnv("AWS_DEFAULT_REGION"),
    hasExplicitCredentials: Boolean(strEnv("AWS_ACCESS_KEY_ID") && strEnv("AWS_SECRET_ACCESS_KEY")),
    configurationSet: strEnv("SES_CONFIGURATION_SET"),
    dailySendLimit: intEnv("MAIL_DAILY_SEND_LIMIT", 500, 0, 1_000_000),
    maxSendRate: intEnv("MAIL_MAX_SEND_RATE", 5, 1, 1000),
    workerConcurrency: intEnv("MAIL_WORKER_CONCURRENCY", 5, 1, 100),
    unsubscribeSecret: strEnv("MAIL_UNSUBSCRIBE_SECRET"),
    publicBaseUrl: (strEnv("PUBLIC_BASE_URL") ?? strEnv("SUTECBA_PUBLIC_BASE_URL"))?.replace(/\/+$/, "") ?? null,
    eventsQueueUrl: strEnv("SES_EVENTS_QUEUE_URL"),
    costPer1000Usd: floatEnv("SES_COST_PER_1000", 0.1),
    leaseSeconds: intEnv("MAIL_LEASE_SECONDS", 120, 10, 3600),
    reinforcedConfirmationThreshold: intEnv("MAIL_REINFORCED_CONFIRMATION_THRESHOLD", 1000, 1, 1_000_000),
    timezone: "America/Argentina/Buenos_Aires",
  };
}

export interface MailConfigIssue {
  key: string;
  message: string;
  /** Sin esto no se puede ENVIAR; el resto degrada (p. ej. eventos). */
  blocking: boolean;
}

/** Validación de configuración para mostrar en la UI y para el arranque del worker. No revela valores. */
export function validateMailConfig(config: MailConfig = loadMailConfig()): MailConfigIssue[] {
  const issues: MailConfigIssue[] = [];
  if (!config.region) issues.push({ key: "AWS_REGION", message: "Falta AWS_REGION.", blocking: true });
  if (!config.unsubscribeSecret || config.unsubscribeSecret.length < 32) {
    issues.push({ key: "MAIL_UNSUBSCRIBE_SECRET", message: "MAIL_UNSUBSCRIBE_SECRET debe tener al menos 32 caracteres.", blocking: true });
  }
  if (!config.publicBaseUrl) issues.push({ key: "PUBLIC_BASE_URL", message: "Falta PUBLIC_BASE_URL (los enlaces de baja la necesitan).", blocking: true });
  if (!config.configurationSet) issues.push({ key: "SES_CONFIGURATION_SET", message: "Sin SES_CONFIGURATION_SET no se reciben eventos (entregas, rebotes, quejas).", blocking: false });
  if (!config.eventsQueueUrl) issues.push({ key: "SES_EVENTS_QUEUE_URL", message: "Sin SES_EVENTS_QUEUE_URL el worker no consume eventos de SES.", blocking: false });
  if (config.dailySendLimit <= 0) issues.push({ key: "MAIL_DAILY_SEND_LIMIT", message: "MAIL_DAILY_SEND_LIMIT es 0: no se enviará nada.", blocking: true });
  return issues;
}

export function describeMailConfig(config: MailConfig = loadMailConfig()) {
  return {
    provider: config.provider,
    region: config.region,
    explicitCredentials: config.hasExplicitCredentials,
    configurationSet: config.configurationSet,
    dailySendLimit: config.dailySendLimit,
    maxSendRate: config.maxSendRate,
    workerConcurrency: config.workerConcurrency,
    unsubscribeSecretSet: Boolean(config.unsubscribeSecret),
    publicBaseUrl: config.publicBaseUrl,
    eventsQueueSet: Boolean(config.eventsQueueUrl),
    costPer1000Usd: config.costPer1000Usd,
  };
}
