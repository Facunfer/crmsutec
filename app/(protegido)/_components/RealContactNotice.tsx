/**
 * Aviso contextual (B5): qué cuenta y qué NO cuenta como «contacto real». El semáforo y «Último contacto» reflejan la verdad del
 * CRM: mientras no existan comunicaciones registradas (Fase F), no hay último contacto y todas las personas figuran como
 * «Sin contacto registrado».
 */
export function RealContactNotice() {
  return (
    <div role="note" className="rounded-md border border-brand-200 bg-brand-50 px-4 py-3 text-xs text-brand-700">
      <p className="font-semibold text-brand-900">¿Qué cuenta como contacto real?</p>
      <p className="mt-1">
        Solo una comunicación efectiva registrada con la persona (llamada, WhatsApp, correo, SMS o conversación presencial).{" "}
        <strong>No cuentan como contacto</strong>: la actividad, la participación, la inscripción, la asistencia, la respuesta a una invitación ni las
        interacciones técnicas heredadas de la carga histórica. Hasta que se registren comunicaciones reales, es correcto que no exista un último
        contacto y que el semáforo figure en gris — «Sin contacto registrado».
      </p>
    </div>
  );
}
