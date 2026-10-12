# Mailing con Amazon SES — Runbook

Estado: implementado en local (migración **0044**, sin commit, sin producción). Este documento es lo que hay que hacer en AWS y en el VPS, y cómo operar.

> Principio: **mailing ≠ contacto real**. Enviar, entregar, abrir, hacer click, rebotar, quejarse o darse de baja NO mueven el semáforo, NO actualizan «Último contacto» y NO crean `person_interactions`. En la ficha de la persona aparece como una línea propia («Mailing — campaña») con `countsAsContact = false`.

## 1. Arquitectura

```
CRM (Next.js)                    PostgreSQL                         Worker PM2 (sutecba-mail)            Amazon
────────────                     ──────────                         ──────────────────────────           ──────
/personas → "Crear mailing"  →   mailing_campaigns                  reclama (FOR UPDATE SKIP LOCKED)  →  SES SendEmail
   congela audiencia             mailing_campaign_recipients  ←──   reserva cuota global (atómica)       (Configuration Set)
/mailing/[id]/editar             mailing_campaign_batches           guarda resultado / lease                     │
/unsubscribe/<token>             mailing_suppressions         ←──   consume eventos  ←─ SQS ←─ SNS ←────────────┘
                                 mailing_events (append-only)
                                 mailing_daily_quota (global)
```

- **Un destinatario = un email normalizado por campaña.** Varias personas pueden compartir el email: se manda **un** mensaje y el saludo es neutro («Hola,»).
- **Audiencia congelada** al crear la campaña (no se recalcula nunca).
- **Cuota diaria global** (`MAIL_DAILY_SEND_LIMIT`), día de Buenos Aires, reserva atómica en PostgreSQL: dos campañas o dos workers no pueden superarla. Varios remitentes **no** multiplican la cuota.
- **Envío incierto nunca se reintenta solo** (`send_unknown`): timeout/corte/5xx de SES, o un worker que murió con un destinatario en vuelo. Lo resuelve una persona (marcar no enviado / reencolar).
- Un rechazo **por ritmo** (throttling) sí se reintenta con espera: SES garantiza que no envió.

## 2. Variables de entorno (`.env` del VPS; nunca en el repo)

| Variable | Obligatoria | Descripción |
|---|---|---|
| `AWS_REGION` | sí | Región de SES (p. ej. `us-east-1`). El código no depende de ninguna. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | sí* | Credenciales del usuario IAM (§4). *Si el servidor usa un rol, no hacen falta. |
| `SES_CONFIGURATION_SET` | recomendada | Nombre del Configuration Set (eventos y métricas). |
| `SES_EVENTS_QUEUE_URL` | recomendada | URL de la cola SQS con los eventos. Sin esto no hay entregas/rebotes/quejas. |
| `MAIL_UNSUBSCRIBE_SECRET` | sí | ≥ 32 caracteres aleatorios. Firma los enlaces de baja (si se cambia, los enlaces ya enviados dejan de servir). |
| `PUBLIC_BASE_URL` | sí | URL pública del CRM/subdominio de mailing, sin `/` final (`https://…`). Va en los enlaces de baja. |
| `MAIL_DAILY_SEND_LIMIT` | sí | Tope diario GLOBAL. Rollout sugerido: 500 → 1.000 → 2.000 → 5.000 → 10.000 → 15.000. Se cambia sin tocar código (reiniciar el worker). |
| `MAIL_MAX_SEND_RATE` | no (5) | Mensajes por segundo (≤ el «maximum send rate» de SES). |
| `MAIL_WORKER_CONCURRENCY` | no (5) | Envíos en paralelo del worker. |
| `MAIL_LEASE_SECONDS` | no (120) | Duración del lease de un envío en curso. |
| `SES_COST_PER_1000` | no (0.10) | USD por 1.000 emails, solo para la estimación en pantalla. |
| `MAIL_REINFORCED_CONFIRMATION_THRESHOLD` | no (1000) | A partir de cuántos destinatarios se muestra la advertencia reforzada. |

Generar el secreto: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.

## 3. Paso a paso en AWS (lo hace la persona titular de la cuenta)

1. **Cuenta AWS institucional.** Crear la cuenta con un email institucional compartido (no personal) y activar MFA en el usuario raíz. No usar el usuario raíz para el CRM.
2. **Elegir región** de SES (la más cercana con SES disponible, p. ej. `us-east-1` o `sa-east-1`). Todo lo siguiente (SES, SNS, SQS) en **la misma región**.
3. **Verificar la identidad de envío.**
   - *Para desarrollar/probar:* SES → Verified identities → Create identity → **Email address** (`comunicaciones@…`). Llega un mail con un enlace.
   - *Para producción:* **Domain** (el subdominio de mailing que se defina, p. ej. `mail.sutecba.org.ar`), con **Easy DKIM**.
4. **DKIM.** Al crear la identidad de dominio SES entrega 3 registros **CNAME**; cargarlos en el DNS. Esperar «Verified».
5. **SPF + MAIL FROM.** En la identidad: *Custom MAIL FROM domain* = `bounce.<dominio>`; cargar el **MX** y el **TXT** (`v=spf1 include:amazonses.com ~all`) que indica SES. Esto alinea SPF con el dominio del remitente.
6. **DMARC.** TXT en `_dmarc.<dominio>`: empezar con `v=DMARC1; p=none; rua=mailto:dmarc@<dominio>` y endurecer a `quarantine`/`reject` cuando los reportes estén limpios.
7. **Salir del sandbox.** SES → Account dashboard → *Request production access*. Describir: remitente institucional, base de afiliados que consintió, manejo de rebotes/quejas (supresión automática), baja de un clic, volumen inicial 500/día creciendo a 15.000/día. **Mientras esté en sandbox el CRM lo muestra en un banner y solo entrega a direcciones verificadas.**
8. **IAM.** Crear un usuario (o rol) solo para el CRM con esta política mínima (ajustar región y cuenta):
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Effect": "Allow", "Action": ["ses:SendEmail", "ses:GetAccount", "ses:GetEmailIdentity"], "Resource": "*" },
       { "Effect": "Allow", "Action": ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
         "Resource": "arn:aws:sqs:REGION:CUENTA:sutecba-ses-events" }
     ]
   }
   ```
   Crear una **access key** y cargarla en el `.env` del VPS. Nunca en el repo, en un chat ni en un ticket.
9. **Configuration Set.** SES → Configuration sets → Create (`sutecba-mailing`). Agregar un **Event destination** de tipo **Amazon SNS** con los eventos: *Send, Delivery, Bounce, Complaint, Reject, Delivery delay*; y *Open, Click* si se quiere (activar *open & click tracking* en el set). Poner el nombre en `SES_CONFIGURATION_SET`.
10. **SNS.** Crear el tópico `sutecba-ses-events` (Standard) y usarlo como destino del paso anterior.
11. **SQS.** Crear la cola **Standard** `sutecba-ses-events` (retención 4 días, visibility timeout 60 s) y una cola de mensajes muertos (DLQ) con *maxReceiveCount* 10. Suscribir la cola al tópico SNS (**sin** *raw message delivery*; el worker acepta ambos formatos) y permitir `sns:Publish` → `sqs:SendMessage` en la política de la cola. Copiar la URL en `SES_EVENTS_QUEUE_URL`.
12. **Verificar remitentes en el CRM.** `/mailing/remitentes` → crear remitentes → «verificar en SES». Un remitente no verificado no puede lanzar campañas.

## 4. Segundo proceso PM2

```bash
cd /opt/sutecba
npm install                       # trae @aws-sdk/client-sesv2 y @aws-sdk/client-sqs
# migración 0044 por el aplicador canónico (backup + preflight antes; ver procedimiento de despliegue)
pm2 start deploy/ecosystem.config.cjs --only sutecba-mail
pm2 save
pm2 logs sutecba-mail --lines 100
```

El worker no abre puertos, usa el mismo rol `sutecba_app` y el mismo `.env`. Si falta configuración bloqueante (`AWS_REGION`, `MAIL_UNSUBSCRIBE_SECRET`, `PUBLIC_BASE_URL`, `MAIL_DAILY_SEND_LIMIT`) arranca, loguea qué falta y **no envía**.

## 5. Probar (de menor a mayor riesgo)

1. `/mailing` → banner: debe decir **Sandbox** (o producción) y no «no configurado».
2. `/mailing/remitentes` → crear remitente con una identidad verificada → «verificar en SES» → *Verificado*.
3. `/personas` → filtrar/seleccionar → **Crear mailing** → ver la audiencia → congelar.
4. Editar → remitente, asunto, contenido → vista previa → **Enviar prueba** a una dirección verificada.
5. Campaña de 2–3 personas **verificadas** (sandbox) → marcar lista → lanzar → el worker envía en segundos.
6. Ver `/mailing/<id>`: enviados → entregados (llegan por SQS). Probar el enlace de baja del mail recibido.
7. Con el simulador de SES (`bounce@simulator.amazonses.com`, `complaint@simulator.amazonses.com`) probar rebote y queja → deben quedar suprimidos.
8. Revisar la ficha de la persona: línea «Mailing — …», **sin** cambio de semáforo.

## 6. Operación

- **Pausar / reanudar / cancelar:** en `/mailing/<id>`. Pausar no reclama nuevos; lo ya reclamado termina. Cancelar no borra historia.
- **Subir el tope:** cambiar `MAIL_DAILY_SEND_LIMIT` en `.env` y `pm2 restart sutecba-mail`. Las campañas ya lanzadas conservan su reparto en días; el tope vigente rige el día.
- **Worker caído:** `pm2 status` / `pm2 logs sutecba-mail`. Reiniciar con `pm2 restart sutecba-mail`. Qué pasa al volver:
  - lo que estaba en cola sigue en cola y continúa;
  - lo que estaba «enviando» con el lease vencido pasa a **«Envío incierto (revisar)»** y **no** se reenvía solo.
- **Envíos inciertos:** en la tabla de destinatarios de la campaña, «marcar no enviado» (si verificaste en SES que no salió) o «reencolar» (aceptás que pueda duplicarse).
- **Eventos que no llegan:** ver que `SES_EVENTS_QUEUE_URL` esté seteado, que la cola tenga mensajes (consola SQS) y la DLQ. Un evento que llega antes de que se guarde el envío se reintenta solo hasta 5 veces.
- **Errores de envío:** en la tabla de destinatarios, columna *Detalle* (código del proveedor; nunca el cuerpo ni datos personales). `MessageRejected` en sandbox = destinatario no verificado.
- **Rechazo a nivel cuenta** (`AccountSuspended`, `SendingPaused`, identidad no verificada): el worker **pausa la campaña** con el motivo y no consume cuota.
- **Logs:** JSON por línea (`campaña`, ids, intento, código de error). No se loguean secretos, tokens, cuerpos ni emails.

## 7. Roles y permisos (decisión PROVISIONAL, a revisar en la Fase C)

| Rol | Mailing |
|---|---|
| MASTER_GLOBAL | todo |
| ADMIN | todo (`view`, `create`, `send`, `manage_senders`, `view_metrics`, `manage_suppressions`) |
| OPERADOR | `view`, `create`, `view_metrics`: crea, prepara, congela audiencias y envía pruebas; **no lanza** |
| LECTURA | `view`, `view_metrics`: solo ve |
| REUNIONES | ninguno |

Además del permiso, el usuario necesita el módulo `mailing` habilitado y su alcance organizativo limita audiencias, remitentes y campañas.

## 8. Baja pública: rate limit

`/unsubscribe/<token>` y `/api/unsubscribe/<token>` limitan por enlace (30 intentos / 10 min) y por IP (600 / 10 min) usando `public_link_attempts`. Al excederse responden 429 (`Retry-After: 600`) y se levanta solo. Repetir una baja ya hecha es idempotente.

## 9. Qué NO hace el MVP (pendiente)

Editor drag-and-drop, automatizaciones, A/B, segmentación dinámica, segunda aprobación humana, analítica avanzada, warming, IP dedicada, plantillas, políticas de reintento para rebotes transitorios (el contador `soft_bounce_count` queda preparado) y reportes Mailing → Formulario → Reunión.
