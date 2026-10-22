"use client";

import { useActionState, useMemo, useState } from "react";
import type { AreaOption, OrgTreeOption } from "@/lib/organizations/areas";
import { AreaReparticionSelect } from "@/components/organizations/AreaReparticionSelect";
import { createActivityAction, type ActivityActionResult } from "./acciones";

const initialState: ActivityActionResult = { ok: false };
const MAX_DATES = 60;
const MAX_QUESTIONS = 20;

type Kind = "single" | "campaign";
interface DateRow {
  startsAt: string;
  endsAt: string;
  locationName: string;
  address: string;
}
interface Question {
  label: string;
  fieldType: "text" | "textarea" | "number" | "date" | "select" | "radio" | "checkbox";
  required: boolean;
  optionsText: string;
}

const QUESTION_TYPES: Array<{ value: Question["fieldType"]; label: string }> = [
  { value: "text", label: "Texto corto" },
  { value: "textarea", label: "Texto largo" },
  { value: "number", label: "Número" },
  { value: "date", label: "Fecha" },
  { value: "select", label: "Lista desplegable" },
  { value: "radio", label: "Opciones (elige una)" },
  { value: "checkbox", label: "Casilla (sí / no)" },
];

const emptyDate = (): DateRow => ({ startsAt: "", endsAt: "", locationName: "", address: "" });
const inputClass = "mt-1 w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm";
const labelClass = "block text-xs text-brand-500";

export function NuevaActividadForm({ areas, orgTree, canPublish }: { areas: AreaOption[]; orgTree: OrgTreeOption[]; canPublish: boolean }) {
  const [state, formAction, pending] = useActionState(createActivityAction, initialState);

  const [kind, setKind] = useState<Kind>("single");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [meetingType, setMeetingType] = useState<"reunion" | "capacitacion">("reunion");
  const [campaignType, setCampaignType] = useState<"vaccination" | "ophthalmology" | "other">("other");
  const [singleDate, setSingleDate] = useState<DateRow>(emptyDate());
  const [campaignDates, setCampaignDates] = useState<DateRow[]>([emptyDate(), emptyDate()]);
  const [qrMode, setQrMode] = useState<"rotating" | "static">("rotating");
  const [toleranceBefore, setToleranceBefore] = useState("30");
  const [toleranceAfter, setToleranceAfter] = useState("60");
  const [capacity, setCapacity] = useState("");
  const [allowUninvited, setAllowUninvited] = useState(false);
  const [enrolls, setEnrolls] = useState(true);
  const [createsPeople, setCreatesPeople] = useState(false);
  const [consentText, setConsentText] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [questions, setQuestions] = useState<Question[]>([]);
  const [publish, setPublish] = useState(canPublish);

  const payload = useMemo(
    () =>
      JSON.stringify({
        kind,
        name,
        description,
        meetingType: kind === "single" ? meetingType : undefined,
        campaignType,
        dates: kind === "single" ? [singleDate] : campaignDates,
        qrMode,
        checkinToleranceBeforeMinutes: Number(toleranceBefore),
        checkinToleranceAfterMinutes: Number(toleranceAfter),
        allowUninvitedCheckin: allowUninvited,
        capacity,
        publish: canPublish && publish,
        form: {
          enrollment: enrolls ? "auto" : "never",
          personCreation: createsPeople ? "when_valid_dni" : "never",
          consentText,
          successMessage,
          extraFields: questions,
        },
      }),
    [kind, name, description, meetingType, campaignType, singleDate, campaignDates, qrMode, toleranceBefore, toleranceAfter, allowUninvited, capacity, canPublish, publish, enrolls, createsPeople, consentText, successMessage, questions]
  );

  const setCampaignDate = (i: number, patch: Partial<DateRow>) => setCampaignDates((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const setQuestion = (i: number, patch: Partial<Question>) => setQuestions((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  return (
    <form action={formAction} className="max-w-3xl space-y-5">
      <input type="hidden" name="payload" value={payload} />

      <section className="space-y-3 rounded-lg bg-white p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-brand-900">1. ¿Qué vas a crear?</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {(
            [
              { value: "single", title: "Reunión de un día", hint: "Una sola fecha, con su formulario y su QR." },
              { value: "campaign", title: "Campaña con varias fechas", hint: "Varias jornadas con un formulario común y un QR por cada fecha." },
            ] as const
          ).map((option) => (
            <label key={option.value} className={`cursor-pointer rounded-lg border p-3 text-sm ${kind === option.value ? "border-brand-600 bg-brand-50" : "border-brand-200"}`}>
              <input type="radio" name="kind-choice" className="mr-2" checked={kind === option.value} onChange={() => setKind(option.value)} />
              <span className="font-medium text-brand-900">{option.title}</span>
              <span className="mt-1 block text-xs text-brand-500">{option.hint}</span>
            </label>
          ))}
        </div>

        <div>
          <label className={labelClass}>Nombre *</label>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={160} className={inputClass} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <AreaReparticionSelect areas={areas} tree={orgTree} name="ownerOrganizationId" areaLabel="Área *" reparticionLabel="Repartición" required />
        </div>
        {kind === "single" ? (
          <div>
            <label className={labelClass}>Tipo de actividad *</label>
            <select value={meetingType} onChange={(e) => setMeetingType(e.target.value as "reunion" | "capacitacion")} className={inputClass}>
              <option value="reunion">Reunión</option>
              <option value="capacitacion">Capacitación</option>
            </select>
          </div>
        ) : (
          <div>
            <label className={labelClass}>Tipo de campaña *</label>
            <select value={campaignType} onChange={(e) => setCampaignType(e.target.value as typeof campaignType)} className={inputClass}>
              <option value="other">Otra</option>
              <option value="vaccination">Vacunación</option>
              <option value="ophthalmology">Oftalmología</option>
            </select>
          </div>
        )}
        <div>
          <label className={labelClass}>Descripción</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={2000} className={inputClass} />
        </div>
      </section>

      <section className="space-y-3 rounded-lg bg-white p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-brand-900">{kind === "single" ? "2. Fecha" : "2. Fechas (una jornada y un QR por cada una)"}</h2>
        {kind === "single" ? (
          <DateFields row={singleDate} onChange={(patch) => setSingleDate((r) => ({ ...r, ...patch }))} />
        ) : (
          <div className="space-y-3">
            {campaignDates.map((row, i) => (
              <div key={i} className="rounded-md border border-brand-100 p-3">
                <div className="mb-2 flex items-center justify-between text-xs font-medium text-brand-700">
                  <span>Fecha {i + 1}</span>
                  {campaignDates.length > 2 ? (
                    <button type="button" onClick={() => setCampaignDates((rows) => rows.filter((_, idx) => idx !== i))} className="text-estado-riesgo hover:underline">
                      Quitar
                    </button>
                  ) : null}
                </div>
                <DateFields row={row} onChange={(patch) => setCampaignDate(i, patch)} />
              </div>
            ))}
            {campaignDates.length < MAX_DATES ? (
              <button type="button" onClick={() => setCampaignDates((rows) => [...rows, emptyDate()])} className="rounded-md border border-brand-300 px-3 py-1.5 text-sm text-brand-700 hover:bg-brand-50">
                + Agregar otra fecha
              </button>
            ) : null}
            <p className="text-xs text-brand-400">Las fechas se ordenan solas por calendario. Una campaña necesita al menos dos.</p>
          </div>
        )}

        <details className="rounded-md border border-brand-100 p-3 text-sm">
          <summary className="cursor-pointer text-xs font-medium text-brand-700">Asistencia y QR (opciones)</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelClass}>Tipo de QR</label>
              <select value={qrMode} onChange={(e) => setQrMode(e.target.value as "rotating" | "static")} className={inputClass}>
                <option value="rotating">Rotativo (se renueva solo; más seguro)</option>
                <option value="static">Fijo (se puede imprimir; puede compartirse)</option>
              </select>
            </div>
            <div>
              <label className={labelClass}>Cupo (opcional)</label>
              <input value={capacity} onChange={(e) => setCapacity(e.target.value)} inputMode="numeric" className={inputClass} placeholder="Sin límite" />
            </div>
            <div>
              <label className={labelClass}>Check-in desde (minutos antes)</label>
              <input value={toleranceBefore} onChange={(e) => setToleranceBefore(e.target.value)} inputMode="numeric" className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Check-in hasta (minutos después)</label>
              <input value={toleranceAfter} onChange={(e) => setToleranceAfter(e.target.value)} inputMode="numeric" className={inputClass} />
            </div>
            <label className="flex items-center gap-2 text-xs text-brand-700 sm:col-span-2">
              <input type="checkbox" checked={allowUninvited} onChange={(e) => setAllowUninvited(e.target.checked)} />
              Permitir el check-in de personas que no fueron invitadas ni se inscribieron
            </label>
          </div>
        </details>
      </section>

      <section className="space-y-3 rounded-lg bg-white p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-brand-900">3. Formulario de inscripción</h2>
        <p className="text-xs text-brand-500">Ya incluye Nombre, Apellido, DNI, Email y Teléfono. Podés agregar preguntas propias.</p>
        <label className="flex items-start gap-2 text-sm text-brand-700">
          <input type="checkbox" className="mt-1" checked={enrolls} onChange={(e) => setEnrolls(e.target.checked)} />
          <span>
            Quien responde queda inscripto {kind === "campaign" ? "en todas las fechas vigentes" : "en la reunión"}.
            <span className="block text-xs text-brand-400">Solo si se lo identifica por DNI con una persona existente de la unidad; si no, la respuesta queda «sin vincular» para que la revise un operador.</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm text-brand-700">
          <input type="checkbox" className="mt-1" checked={createsPeople} onChange={(e) => setCreatesPeople(e.target.checked)} />
          <span>
            Crear la ficha si la persona no existe (requiere un DNI válido).
            <span className="block text-xs text-brand-400">Por defecto está apagado para no cargar datos personales sin revisar.</span>
          </span>
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={labelClass}>Texto de consentimiento (opcional)</label>
            <textarea value={consentText} onChange={(e) => setConsentText(e.target.value)} rows={2} className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>Mensaje al enviar (opcional)</label>
            <textarea value={successMessage} onChange={(e) => setSuccessMessage(e.target.value)} rows={2} className={inputClass} />
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-xs font-medium text-brand-700">Preguntas propias</div>
          {questions.map((q, i) => (
            <div key={i} className="space-y-2 rounded-md border border-brand-100 p-3">
              <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                <input value={q.label} onChange={(e) => setQuestion(i, { label: e.target.value })} placeholder="Texto de la pregunta" maxLength={120} className="w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm" />
                <select value={q.fieldType} onChange={(e) => setQuestion(i, { fieldType: e.target.value as Question["fieldType"] })} className="rounded-md border border-brand-200 px-2 py-1.5 text-sm">
                  {QUESTION_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              {q.fieldType === "select" || q.fieldType === "radio" ? (
                <textarea value={q.optionsText} onChange={(e) => setQuestion(i, { optionsText: e.target.value })} rows={3} placeholder={"Una opción por línea\nMañana\nTarde"} className="w-full rounded-md border border-brand-200 px-2 py-1.5 text-sm" />
              ) : null}
              <div className="flex items-center justify-between text-xs">
                <label className="flex items-center gap-2 text-brand-700">
                  <input type="checkbox" checked={q.required} onChange={(e) => setQuestion(i, { required: e.target.checked })} />
                  Obligatoria
                </label>
                <button type="button" onClick={() => setQuestions((rows) => rows.filter((_, idx) => idx !== i))} className="text-estado-riesgo hover:underline">
                  Quitar
                </button>
              </div>
            </div>
          ))}
          {questions.length < MAX_QUESTIONS ? (
            <button type="button" onClick={() => setQuestions((rows) => [...rows, { label: "", fieldType: "text", required: false, optionsText: "" }])} className="rounded-md border border-brand-300 px-3 py-1.5 text-sm text-brand-700 hover:bg-brand-50">
              + Agregar pregunta
            </button>
          ) : null}
        </div>
      </section>

      <section className="space-y-3 rounded-lg bg-white p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-brand-900">4. Publicación</h2>
        <label className="flex items-start gap-2 text-sm text-brand-700">
          <input type="radio" name="publish-choice" className="mt-1" disabled={!canPublish} checked={canPublish && publish} onChange={() => setPublish(true)} />
          <span>
            Programar y publicar ahora
            <span className="block text-xs text-brand-400">La actividad queda programada, el formulario público y el QR listo para cuando llegue la fecha.</span>
            {!canPublish ? <span className="block text-xs text-estado-alerta">Tu usuario no tiene permiso para programar: se guardará como borrador.</span> : null}
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm text-brand-700">
          <input type="radio" name="publish-choice" className="mt-1" checked={!canPublish || !publish} onChange={() => setPublish(false)} />
          <span>
            Guardar como borrador
            <span className="block text-xs text-brand-400">Nada se publica ni queda visible para el público hasta que lo programes.</span>
          </span>
        </label>
      </section>

      {state.error ? <p className="rounded-md bg-estado-riesgo/10 px-3 py-2 text-sm text-estado-riesgo">{state.error}</p> : null}
      <button type="submit" disabled={pending} className="rounded-md bg-brand-600 px-5 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60">
        {pending ? "Creando..." : kind === "campaign" ? "Crear campaña" : "Crear reunión"}
      </button>
    </form>
  );
}

function DateFields({ row, onChange }: { row: DateRow; onChange: (patch: Partial<DateRow>) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div>
        <label className={labelClass}>Inicio *</label>
        <input type="datetime-local" required value={row.startsAt} onChange={(e) => onChange({ startsAt: e.target.value })} className={inputClass} />
      </div>
      <div>
        <label className={labelClass}>Fin *</label>
        <input type="datetime-local" required value={row.endsAt} onChange={(e) => onChange({ endsAt: e.target.value })} className={inputClass} />
      </div>
      <div>
        <label className={labelClass}>Lugar</label>
        <input value={row.locationName} onChange={(e) => onChange({ locationName: e.target.value })} maxLength={200} className={inputClass} />
      </div>
      <div>
        <label className={labelClass}>Dirección</label>
        <input value={row.address} onChange={(e) => onChange({ address: e.target.value })} maxLength={300} className={inputClass} />
      </div>
    </div>
  );
}
