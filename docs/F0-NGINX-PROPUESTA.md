# F0 — Propuesta de cambios en nginx (NO aplicada)

> Estado: **propuesta**. No se modificó nginx ni nada del VPS. Cada paso lo ejecuta el titular del servidor, uno por vez, con la guarda de
> hostname habitual, y recién después de que el informe F0 esté aprobado. El VPS es compartido: ningún cambio debe tocar otros `server {}`.

## 1. Qué hace hoy la aplicación con la IP del cliente

Desde F0 la aplicación toma la IP del **último** valor de `X-Forwarded-For` (el que agrega nuestro nginx), configurable con
`SUTECBA_TRUSTED_PROXY_HOPS` (default `1` = un nginx delante). El primer valor, que escribe el cliente, se ignora.

Con la configuración documentada (`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`) esto es correcto: nginx conserva lo que
mandó el cliente y **agrega al final** la IP real de la conexión.

## 2. Verificación previa (solo lectura) — OBLIGATORIA antes de desplegar F0

Hay que confirmar que **delante de la app hay exactamente un proxy propio** y qué escribe en `X-Forwarded-For`:

```bash
# Solo lectura. Ejecutar en el VPS de SUTECBA (verificar hostname antes).
sudo nginx -T 2>/dev/null | grep -n -E "server_name|X-Forwarded-For|X-Real-IP|set_real_ip_from|real_ip_header|proxy_pass" | grep -i -B2 -A4 sutecba
```

Casos y qué hacer:

| Lo que se ve | Interpretación | `SUTECBA_TRUSTED_PROXY_HOPS` |
|---|---|---|
| `X-Forwarded-For $proxy_add_x_forwarded_for` y nginx recibe a los clientes directo | un proxy propio | `1` (default, no hace falta definirlo) |
| `X-Forwarded-For $remote_addr` | un proxy propio que pisa el encabezado | `1` |
| Hay otro proxy/CDN delante de nginx (p. ej. Cloudflare) | **dos** saltos: `1` tomaría la IP del CDN y todos los usuarios compartirían un cubo de límites | `2` **y** revisar `real_ip` (sección 3) |
| La app se expone directo, sin nginx | ningún proxy | `0` |

**Si el valor no es el correcto, el efecto es un límite por IP mal agrupado (todos juntos, o ninguno), no una caída.** Por eso se verifica antes.

## 3. Cambios propuestos (opcionales, defensa en profundidad)

### 3.1 Que nginx PISE el encabezado en lugar de agregarlo

En el `location` que hace `proxy_pass` a la app, para que el valor llegue sin rastro de lo que mande el cliente:

```nginx
proxy_set_header X-Forwarded-For $remote_addr;   # en lugar de $proxy_add_x_forwarded_for
proxy_set_header X-Real-IP       $remote_addr;
```

Solo es válido si nginx recibe a los clientes **directamente** (sin CDN delante). Con esto, izquierda y derecha son la misma IP y el
sistema deja de depender de contar saltos.

### 3.2 Si hubiera un CDN delante

```nginx
set_real_ip_from <rango-del-CDN>;   # un set_real_ip_from por rango publicado por el proveedor
real_ip_header   CF-Connecting-IP;  # o X-Forwarded-For + real_ip_recursive on
real_ip_recursive on;
```

y luego `proxy_set_header X-Forwarded-For $remote_addr;`. Solo ese `server {}`.

### 3.3 Freno barato antes de llegar a la app (rate limit de nginx)

Complementa (no reemplaza) los límites atómicos de la base. En `http {}`:

```nginx
limit_req_zone $binary_remote_addr zone=sutecba_public:10m rate=10r/s;
```

y en el `server {}` de SUTECBA:

```nginx
location ~ ^/(f|reunion|unsubscribe|api/unsubscribe|login)(/|$) {
    limit_req zone=sutecba_public burst=40 nodelay;
    limit_req_status 429;
    client_max_body_size 256k;      # un formulario público no necesita más
    # ...el mismo proxy_pass / proxy_set_header del location principal
}
```

`burst=40` y `10r/s` por IP toleran un wifi de acto (cientos de personas, pocas por segundo cada una) y frenan ráfagas automáticas. Ajustar
con datos reales antes de activar.

## 4. Aplicación y reversión

1. Copia del archivo (`cp -a /etc/nginx/sites-available/<sitio> /root/backup/<sitio>.pre-f0`).
2. Cambio en el `server {}` de SUTECBA solamente.
3. `nginx -t` (si falla, restaurar la copia y **no** recargar).
4. `systemctl reload nginx` (reload, no restart: no corta conexiones).
5. Reversión: restaurar la copia + `nginx -t` + `reload`.

Nada de esto es necesario para que F0 funcione: es solo la verificación de la sección 2 lo que hay que hacer antes del despliegue.
