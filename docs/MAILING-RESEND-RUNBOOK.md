# Mailing con Resend — Runbook

Estado: implementado en local (migración **0045**), sin commit ni producción. Resend es un **segundo proveedor**: Amazon SES sigue disponible y es el valor por defecto. La arquitectura (campañas, snapshots, cuota global, worker, suppressions, baja, timeline) no cambia.

> Principio heredado: **mailing ≠ contacto real**. Ningún evento de Resend (entrega, apertura, click, rebote, queja) crea `person_interactions` ni mueve el semáforo.

## 1. Cómo se elige el proveedor

`MAIL_PROVIDER=ses|resend` en el `.env` del VPS (sin valor = `ses`). Un valor inválido **bloquea el envío** (no cae en silencio a otro proveedor). Cambiarlo requiere `pm2 restart sutecba sutecba-mail`.

Reglas que hacen seguro el cambio:

- **El remitente se verifica por proveedor.** Un remitente comprobado con SES no sirve para Resend hasta que se vuelva a verificar (botón «verificar» en `/mailing/remitentes`). La verificación nunca se hereda.
- **Cada campaña queda atada al proveedor con que se lanzó** (`mailing_campaigns.provider`). El worker solo reclama campañas del proveedor activo: una campaña lanzada con SES que siga en curso **espera** si se cambia a Resend (no se mezcla, no se pierde, no se duplica). Para terminarla, volver a `MAIL_PROVIDER=ses`.
- **El historial de SES no se toca.** Eventos, métricas, supresiones y campañas anteriores conservan su proveedor y sus claves (`ses:...`). La cola SQS de SES se sigue consumiendo si `SES_EVENTS_QUEUE_URL` está configurada.
- Las supresiones (baja, rebote, queja) son **globales** por email y valen para ambos proveedores.

## 2. Variables de entorno (`.env` del VPS; nunca en el repo ni en el chat)

| Variable | Obligatoria | Descripción |
|---|---|---|
| `MAIL_PROVIDER` | no (`ses`) | `ses` o `resend`. |
| `RESEND_API_KEY` | sí con `resend` | Clave `Sending access`. Solo permite enviar. |
| `RESEND_WEBHOOK_SECRET` | recomendada | `whsec_...` del webhook. Sin él, el envío funciona pero no se registran entregas/rebotes/quejas (el endpoint responde 503). |
| `MAIL_DAILY_SEND_LIMIT`, `MAIL_MAX_SEND_RATE`, `MAIL_WORKER_CONCURRENCY`, `MAIL_LEASE_SECONDS`, `MAIL_UNSUBSCRIBE_SECRET`, `PUBLIC_BASE_URL` | igual que SES | Se reutilizan. |
| `AWS_*`, `SES_*` | solo para `ses` | Se conservan sin tocar. |

Guardar un secreto en el VPS sin dejarlo en el historial de shell:

```bash
cd /opt/sutecba
read -rs -p "RESEND_API_KEY: " V; echo
printf 'RESEND_API_KEY=%s\n' "$V" >> .env
unset V
chmod 600 .env
```

(Repetir para `RESEND_WEBHOOK_SECRET`. Para editar una línea ya existente, usar `nano .env`.)

## 3. Webhook en el panel de Resend

1. Resend → **Webhooks** → *Add Webhook*.
2. **Endpoint URL**: `https://<PUBLIC_BASE_URL>/api/mailing/webhooks/resend` (HTTPS válido y público).
3. **Events**: `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.opened`, `email.clicked`, `email.failed`, `email.suppressed`.
4. Crear y copiar el **Signing secret** (`whsec_...`) directo al `.env` como en §2. No se pega en ningún chat.
5. `pm2 restart sutecba`: la app lee el `.env` al arrancar, así que sin reiniciar no toma el secreto.

El endpoint verifica la firma Svix sobre el cuerpo crudo antes de tocar la base: 401 si es inválida o el timestamp tiene más de 5 minutos; 503 si no hay secreto o si el evento es reciente y todavía no se guardó el id del envío (Resend reintenta); 200 si se aplicó, es duplicado o se ignora.

## 4. Mapeo de eventos Resend → modelo existente

| Resend | Tipo interno | Efecto |
|---|---|---|
| `email.sent` | `send` | solo registro |
| `email.delivered` | `delivery` | `delivered` (nunca pisa bounced/complained/unsubscribed) |
| `email.delivery_delayed` | `delivery_delay` | solo registro |
| `email.bounced` (`Permanent`) | `bounce` | `bounced` + supresión `hard_bounce` (origen `resend_event`) |
| `email.bounced` (otro tipo) | `soft_bounce` | solo cuenta; **nunca suprime** ante la duda |
| `email.complained` | `complaint` | `complained` + supresión `complaint` |
| `email.opened` / `email.clicked` | `open` / `click` | contadores |
| `email.failed` | `reject` | `failed` (salvo bounced/complained/unsubscribed) |
| `email.suppressed` | `reject` (`reason: suppressed`) | `failed`; Resend lo descartó por su propia lista |
| `email.received`, `email.scheduled`, `domain.*`, `contact.*`, `suppression.*` | — | ignorados (200) |

Sin equivalente exacto en SES: `email.suppressed` (se representa como `reject`) y `email.failed` (ídem). No se agregaron tipos nuevos, así que **no hay cambios en `mailing_events.event_type`**.

La clave de idempotencia es `resend:<email_id>:<tipo>:<hash(instante+detalle)>` (contenido, no solo `svix-id`): un reintento y una repetición manual desde el panel colapsan en el mismo evento.

## 5. Envío, errores y reintentos

- `POST https://api.resend.com/emails`, con `Idempotency-Key = sutecba-mail-<recipient_id>-<intento>`: el mismo intento no se duplica aunque se repita la llamada.
- `200` → `sent` + `provider_message_id`.
- `400/401/403/404/422` → rechazo definitivo (`failed`). Con códigos de **cuenta** (`missing_api_key`, `restricted_api_key`, `suspended_api_key`, `domain_not_verified`, `daily_quota_exceeded`, `monthly_quota_exceeded`) el worker **pausa la campaña** y devuelve el destinatario a la cola; no falla uno por uno.
- `429 rate_limit_exceeded` → reencola con espera (30 s … 15 min), devuelve la cuota, nunca pasa a `failed`.
- `5xx`, timeout, corte de red, `409` → **`send_unknown`**: no se reintenta sola; requiere revisión humana (igual que con SES).
- Límite por defecto de Resend: 10 req/s por equipo. Con `MAIL_MAX_SEND_RATE=5` (valor por defecto) queda holgado.

## 6. Verificación de remitentes

Una clave `Sending access` no puede consultar dominios (Resend responde `restricted_api_key`). La identidad se comprueba con un **envío de prueba a `delivered@resend.dev`**: Resend lo acepta solo si el dominio del remitente está verificado (`200` → verificado; `403 validation_error` → pendiente). No llega a ninguna persona real, pero **cuenta contra la cuota** de Resend. Nunca se marca verificado sin esa respuesta.

## 7. Plan de activación gradual (sugerido)

1. Prueba directa de Resend (hecha).
2. `MAIL_PROVIDER=resend` con `MAIL_DAILY_SEND_LIMIT=50` → verificar remitente → campaña de 1–3 personas propias.
3. Confirmar entrega, `provider_message_id`, eventos del webhook y baja.
4. Subir el tope en pasos: 100 → 250 → 500 → 1.000 → 2.000, esperando al menos un día entre pasos y revisando rebotes (< 2 %) y quejas (< 0,1 %) en el panel antes de cada subida.
5. Los límites del plan de Resend (diario/mensual) deben confirmarse en su documentación vigente antes de superar el plan gratuito.

## 8. Rollback

- **Operativo (inmediato, sin tocar datos):** `MAIL_PROVIDER=ses` (o quitar la variable) y `pm2 restart sutecba sutecba-mail`. Las campañas lanzadas con Resend que sigan en curso quedan en espera hasta volver a Resend; no se pierden.
- **Webhook:** pausar o borrar el endpoint en el panel de Resend.
- **Migración 0045:** es aditiva y compatible hacia atrás; **no hace falta revertirla** para volver a SES. Si hiciera falta, solo es posible mientras no exista ninguna fila con `provider = 'resend'`. **Siempre dentro de una transacción**: sin ella, un `DROP` exitoso seguido de un `ADD` fallido dejaría la tabla sin restricción. Si hay filas `resend`, el `ADD` falla y el `ROLLBACK` deja todo como estaba.

```sql
BEGIN;
ALTER TABLE public.mailing_senders  DROP CONSTRAINT mailing_senders_provider_check;
ALTER TABLE public.mailing_senders  ADD  CONSTRAINT mailing_senders_provider_check  CHECK (provider IN ('ses'));
ALTER TABLE public.mailing_campaigns DROP CONSTRAINT mailing_campaigns_provider_check;
ALTER TABLE public.mailing_campaigns ADD  CONSTRAINT mailing_campaigns_provider_check CHECK (provider IN ('ses'));
COMMIT;
```

## 9. Migrar la URL pública a `https://crm.sutecba.com` (sin cortar nada)

Propuesta, **sin ejecutar** hasta autorización. Aplica a la app; no toca `sutecba.com` (sitio principal) ni los registros DNS de SES/Resend (DKIM, SPF, MX de `send.`, DMARC).

1. **DNS (Hostinger):** agregar un registro `A` para `crm` → IP del VPS (`145.223.92.253`). Es un registro nuevo: no modifica ninguno existente. Esperar propagación (`nslookup crm.sutecba.com`).
2. **nginx:** agregar un `server_name crm.sutecba.com` al sitio existente (o un segundo `server` con el mismo `proxy_pass` al puerto 3100). `sutecba.duckdns.org` **se mantiene** en paralelo.
3. **Certificado:** `certbot --nginx -d crm.sutecba.com` emite un certificado nuevo; no renueva ni toca el de duckdns.
4. **Probar** `https://crm.sutecba.com/login` y `/unsubscribe/token-invalido`.
5. **Recién entonces** cambiar `PUBLIC_BASE_URL=https://crm.sutecba.com` y reiniciar app y worker. A partir de ahí los correos nuevos llevan enlaces a `crm.sutecba.com`.
6. Los enlaces de baja **ya enviados** apuntan a `sutecba.duckdns.org`: mantener ese host activo mientras haya correos en circulación (el token firmado no depende del host).
7. Actualizar la URL del webhook en el panel de Resend (o crear uno nuevo y borrar el viejo después de comprobar entregas).

Riesgos: bajo. El mayor es olvidar mantener el host viejo vivo para las bajas ya enviadas.
