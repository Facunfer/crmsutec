"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { AudienceStats } from "@/lib/mailing/audience";
import { launchAction, renderPreviewAction, saveDraftAction, sendTestAction } from "../../acciones";

const nf = new Intl.NumberFormat("es-AR");

interface Props {
  campaign: {
    id: string;
    name: string;
    subject: string;
    preheader: string;
    senderId: string;
    replyTo: string;
    htmlBody: string;
    textBody: string;
    status: "draft" | "ready";
    stats: AudienceStats;
    totalRecipients: number;
  };
  senders: Array<{ id: string; name: string; fromName: string; fromEmail: string; verifiedStatus: string; isDefault: boolean }>;
  sandbox: boolean;
  dailyLimit: number;
  quotaRemaining: number;
  estimatedDays: number;
  canSend: boolean;
  reinforcedThreshold: number;
  configIssues: string[];
}

const VERIFIED_LABEL: Record<string, string> = { verified: "verificado", pending: "pendiente de verificar", failed: "falló la verificación", unknown: "sin verificar" };

export function CampaignEditor({ campaign, senders, sandbox, dailyLimit, quotaRemaining, estimatedDays, canSend, reinforcedThreshold, configIssues }: Props) {
  const router = useRouter();
  const [name, setName] = useState(campaign.name);
  const [subject, setSubject] = useState(campaign.subject);
  const [preheader, setPreheader] = useState(campaign.preheader);
  const [senderId, setSenderId] = useState(campaign.senderId || senders.find((s) => s.isDefault)?.id || "");
  const [replyTo, setReplyTo] = useState(campaign.replyTo);
  const [htmlBody, setHtmlBody] = useState(campaign.htmlBody);
  const [textBody, setTextBody] = useState(campaign.textBody);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [preview, setPreview] = useState<{ html: string; subject: string; unknown: string[] } | null>(null);
  const [mobile, setMobile] = useState(false);
  const [shared, setShared] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [confirmCount, setConfirmCount] = useState("");
  const [ackSandbox, setAckSandbox] = useState(false);
  const [scheduledAt, setScheduledAt] = useState("");
  const [pending, startTransition] = useTransition();

  const sender = senders.find((s) => s.id === senderId);
  const draft = { name, subject, preheader, senderId, replyTo, htmlBody, textBody };
  const ready = campaign.status === "ready";
  const reinforced = campaign.totalRecipients > reinforcedThreshold;

  function save(markReady: boolean) {
    setMessage(null);
    startTransition(async () => {
      const r = await saveDraftAction(campaign.id, draft, markReady);
      if (r.ok) {
        setMessage({ kind: "ok", text: markReady ? "Campaña marcada como lista." : `Borrador guardado.${r.warnings?.length ? " " + r.warnings.join(" ") : ""}` });
        router.refresh();
      } else setMessage({ kind: "error", text: r.error ?? "No se pudo guardar." });
    });
  }

  function refreshPreview() {
    startTransition(async () => {
      const r = await renderPreviewAction({ subject, preheader, htmlBody, textBody, shared });
      if (r.ok) setPreview({ html: r.html ?? "", subject: r.subject ?? "", unknown: r.unknown ?? [] });
    });
  }

  function sendTest() {
    setMessage(null);
    startTransition(async () => {
      // La prueba usa lo guardado: se guarda primero.
      const saved = await saveDraftAction(campaign.id, draft, false);
      if (!saved.ok) return setMessage({ kind: "error", text: saved.error ?? "No se pudo guardar antes de la prueba." });
      const r = await sendTestAction(campaign.id, testTo);
      if (!r.ok) return setMessage({ kind: "error", text: r.error ?? "No se pudo enviar la prueba." });
      if (r.result?.outcome === "accepted") setMessage({ kind: "ok", text: `Prueba enviada a ${testTo}. En Sandbox solo llega a direcciones verificadas.` });
      else setMessage({ kind: "error", text: `Amazon SES no envió la prueba (${r.result?.code ?? r.result?.outcome}).` });
    });
  }

  function launch() {
    setMessage(null);
    startTransition(async () => {
      const r = await launchAction(campaign.id, { confirmRecipients: Number(confirmCount), acknowledgeSandbox: ackSandbox, scheduledAt });
      if (r.ok) router.push(`/mailing/${campaign.id}`);
      else setMessage({ kind: "error", text: r.error ?? "No se pudo lanzar." });
    });
  }

  const input = "w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm";
  const section = "space-y-3 rounded-lg bg-white p-4 shadow-sm";
  const h2 = "text-sm font-semibold text-brand-900";

  return (
    <div className="space-y-4">
      {message ? (
        <p className={`rounded-md px-3 py-2 text-sm ${message.kind === "ok" ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"}`}>{message.text}</p>
      ) : null}

      <section className={section}>
        <h2 className={h2}>1. Audiencia (congelada)</h2>
        <p className="text-sm text-brand-600">
          {nf.format(campaign.stats.selected)} seleccionadas · {nf.format(campaign.stats.withEmail)} con email · {nf.format(campaign.stats.withoutEmail)} sin email ·{" "}
          {nf.format(campaign.stats.invalid)} inválidos · {nf.format(campaign.stats.duplicates)} duplicados · {nf.format(campaign.stats.suppressed)} suprimidos →{" "}
          <strong>{nf.format(campaign.totalRecipients)} destinatarios finales</strong>
        </p>
      </section>

      <section className={section}>
        <h2 className={h2}>2. Remitente</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-brand-500">Remitente</span>
            <select value={senderId} onChange={(e) => setSenderId(e.target.value)} className={input}>
              <option value="">— elegir —</option>
              {senders.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {s.fromName} &lt;{s.fromEmail}&gt; ({VERIFIED_LABEL[s.verifiedStatus] ?? s.verifiedStatus})
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-brand-500">Responder a (opcional)</span>
            <input value={replyTo} onChange={(e) => setReplyTo(e.target.value)} className={input} placeholder="Si queda vacío, el del remitente" />
          </label>
        </div>
        {senders.length === 0 ? <p className="text-sm text-amber-800">No hay remitentes disponibles. Pedí a un administrador que cree uno en Mailing → Remitentes.</p> : null}
        {sender && sender.verifiedStatus !== "verified" ? <p className="text-sm text-amber-800">Este remitente no está verificado en Amazon SES: no se podrá enviar con él.</p> : null}
      </section>

      <section className={section}>
        <h2 className={h2}>3. Contenido</h2>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-brand-500">Nombre interno</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className={input} maxLength={160} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-brand-500">Asunto</span>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} className={input} maxLength={300} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-brand-500">Preheader (texto previo en la bandeja, opcional)</span>
          <input value={preheader} onChange={(e) => setPreheader(e.target.value)} className={input} maxLength={300} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-brand-500">Contenido HTML</span>
          <textarea value={htmlBody} onChange={(e) => setHtmlBody(e.target.value)} rows={12} className={`${input} font-mono text-xs`} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-brand-500">Texto plano (si queda vacío se arma desde el HTML)</span>
          <textarea value={textBody} onChange={(e) => setTextBody(e.target.value)} rows={5} className={`${input} font-mono text-xs`} />
        </label>
        <p className="text-xs text-brand-500">
          Variables: <code>{"{{nombre}}"}</code> <code>{"{{apellido}}"}</code> <code>{"{{nombre_completo}}"}</code> <code>{"{{organizacion}}"}</code> · con valor por defecto:{" "}
          <code>{"{{nombre|compañero/a}}"}</code>. El enlace de baja se agrega solo (o usá <code>{"{{baja_url}}"}</code>). El HTML se sanitiza: sin scripts ni formularios.
        </p>
        <div className="flex gap-2">
          <button type="button" disabled={pending} onClick={() => save(false)} className="rounded-md border border-brand-200 px-3 py-1.5 text-sm text-brand-700 hover:bg-brand-50 disabled:opacity-50">
            Guardar borrador
          </button>
        </div>
      </section>

      <section className={section}>
        <h2 className={h2}>4. Vista previa</h2>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <button type="button" onClick={refreshPreview} disabled={pending} className="rounded-md border border-brand-200 px-3 py-1.5 text-brand-700 hover:bg-brand-50 disabled:opacity-50">
            Actualizar vista previa
          </button>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={mobile} onChange={(e) => setMobile(e.target.checked)} /> Móvil
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> Email compartido (saludo neutro)
          </label>
        </div>
        {preview ? (
          <div className="space-y-2">
            <p className="text-sm text-brand-700">
              <span className="text-brand-400">Asunto:</span> {preview.subject}
            </p>
            {preview.unknown.length > 0 ? <p className="text-xs text-amber-800">Variables desconocidas (se eliminarán): {preview.unknown.join(", ")}</p> : null}
            <iframe
              title="Vista previa del mailing"
              sandbox=""
              srcDoc={preview.html}
              className="h-[480px] rounded-md border border-brand-200 bg-white"
              style={{ width: mobile ? 375 : "100%" }}
            />
          </div>
        ) : null}
      </section>

      <section className={section}>
        <h2 className={h2}>5. Enviar prueba</h2>
        <div className="flex flex-wrap items-end gap-2 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-brand-500">Email de prueba</span>
            <input value={testTo} onChange={(e) => setTestTo(e.target.value)} className="w-72 rounded-md border border-brand-200 px-2 py-1.5" placeholder="tu.email@dominio.com" />
          </label>
          <button type="button" onClick={sendTest} disabled={pending || !testTo} className="rounded-md border border-brand-200 px-3 py-1.5 text-brand-700 hover:bg-brand-50 disabled:opacity-50">
            Enviar prueba
          </button>
        </div>
        <p className="text-xs text-brand-500">La prueba no usa destinatarios reales ni consume cuota de la campaña. {sandbox ? "En Sandbox, el email de prueba tiene que estar verificado en SES." : ""}</p>
      </section>

      <section className={section}>
        <h2 className={h2}>6. Confirmar y lanzar</h2>
        <ul className="space-y-1 text-sm text-brand-700">
          <li>
            Destinatarios finales: <strong>{nf.format(campaign.totalRecipients)}</strong>
          </li>
          <li>
            Remitente: {sender ? `${sender.fromName} <${sender.fromEmail}>` : "—"} · asunto: {subject || "—"}
          </li>
          <li>
            Tope diario global: {nf.format(dailyLimit)} · disponible hoy: {nf.format(quotaRemaining)} · días estimados de envío: {estimatedDays}
          </li>
          <li>Los suprimidos ({nf.format(campaign.stats.suppressed)}) no recibirán nada.</li>
        </ul>
        {configIssues.length > 0 ? <p className="text-sm text-amber-800">Falta configuración de envío: {configIssues.join(", ")}.</p> : null}
        {sandbox ? (
          <label className="flex items-start gap-2 text-sm text-amber-900">
            <input type="checkbox" className="mt-1" checked={ackSandbox} onChange={(e) => setAckSandbox(e.target.checked)} />
            <span>Entiendo que Amazon SES está en Sandbox: solo se entregará a direcciones verificadas y el resto fallará.</span>
          </label>
        ) : null}
        {reinforced ? <p className="text-sm font-medium text-amber-900">Envío grande (más de {nf.format(reinforcedThreshold)} destinatarios): revisá remitente, asunto y cantidad antes de confirmar.</p> : null}
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <button type="button" disabled={pending || ready} onClick={() => save(true)} className="rounded-md border border-brand-200 px-3 py-1.5 text-brand-700 hover:bg-brand-50 disabled:opacity-50">
            {ready ? "Lista para lanzar ✓" : "Guardar y marcar como lista"}
          </button>
          {canSend ? (
            <>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-brand-500">Programar (opcional)</span>
                <input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} className="rounded-md border border-brand-200 px-2 py-1.5" />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-brand-500">Escribí {nf.format(campaign.totalRecipients)} para confirmar</span>
                <input value={confirmCount} onChange={(e) => setConfirmCount(e.target.value.replace(/\D/g, ""))} className="w-40 rounded-md border border-brand-200 px-2 py-1.5" />
              </label>
              <button
                type="button"
                onClick={launch}
                disabled={pending || !ready || Number(confirmCount) !== campaign.totalRecipients || (sandbox && !ackSandbox)}
                className="rounded-md bg-brand-600 px-3 py-1.5 text-white hover:bg-brand-700 disabled:opacity-50"
              >
                Lanzar campaña
              </button>
            </>
          ) : (
            <p className="text-xs text-brand-500">Lanzar requiere el permiso de envío de mailing.</p>
          )}
        </div>
      </section>
    </div>
  );
}
