# Desplegar SUTECBA en un VPS, sin dominio, para que alguien lo vea

> No toco tu VPS directamente desde esta sesión (corre en tu máquina Windows, no tiene acceso SSH al servidor). Esta es la guía para que la sigas vos por SSH. Los comandos asumen Ubuntu/Debian (`apt`, `ufw`) — si tu VPS es otra distro (CentOS/RHEL/Alma), avisame y te la adapto (`dnf`/`yum`, `firewalld` en vez de `ufw`).

## Qué vas a lograr

El CRM corriendo en tu VPS, con HTTPS (autofirmado, sin necesidad de un dominio real), en un link tipo `https://TU_IP_PUBLICA/` que le podés mandar a cualquiera para que lo mire — sin comprar dominio, sin esperar propagación de DNS.

**Por qué HTTPS y no HTTP plano**: la cookie de sesión (`lib/auth/cookies.ts`) se marca `Secure` en producción a propósito (para que nunca viaje sin cifrar). Los navegadores **ignoran** una cookie `Secure` si la conexión es HTTP plano — con HTTP plano el login parecería funcionar (redirige) pero la sesión nunca queda guardada, y termina en un loop de "iniciá sesión de nuevo". Un certificado autofirmado resuelve esto sin tocar código: el navegador va a mostrar una advertencia ("conexión no segura" / "certificado no confiable") que la persona tiene que aceptar una vez — normal para un demo sin dominio, no es un error.

## Antes de empezar, necesitás saber

- La IP pública de tu VPS (`TU_IP` de acá en adelante).
- Un usuario con acceso SSH y `sudo`.
- Qué motor de base vas a usar para este despliegue: **recomiendo PGlite** (el mismo motor embebido que usás en desarrollo, sin instalar nada aparte) para un demo rápido. Si en algún momento esto deja de ser "para que alguien lo mire" y pasa a producción real, ahí sí conviene un Postgres de verdad (`SUTECBA_DATABASE_URL`) — el código ya soporta las dos formas sin cambios (decisión D2).

## Paso 1 — Subir el código al VPS

Desde tu máquina, con el proyecto en `C:\Users\usuario\Downloads\sutecba`. Usando `scp` (viene con Git Bash, que ya estás usando):

```bash
# Desde tu máquina Windows (Git Bash), parado en la carpeta del proyecto
tar --exclude='node_modules' --exclude='.next' --exclude='.data' --exclude='.git' -czf sutecba.tar.gz .
scp sutecba.tar.gz tu_usuario@TU_IP:/tmp/
```

En el VPS (por SSH):

```bash
ssh tu_usuario@TU_IP
sudo mkdir -p /opt/sutecba
sudo tar -xzf /tmp/sutecba.tar.gz -C /opt/sutecba
sudo chown -R $USER:$USER /opt/sutecba
cd /opt/sutecba
```

*(Si preferís usar git en vez de `scp`: creá un repo vacío en GitHub/GitLab, hacé `git push` desde tu máquina, y `git clone` en el VPS. Sin remoto configurado hoy en este repo — decílo si querés que te arme ese camino en vez de este.)*

## Paso 2 — Node.js en el VPS

Comprobá si ya está:

```bash
node --version   # necesitás 20.x o más nuevo
```

Si no está o es viejo:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

## Paso 3 — Instalar dependencias

```bash
cd /opt/sutecba
npm install
```

## Paso 4 — Variables de entorno de producción

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Copiá ese valor y editá `.env` (`nano .env`):

```bash
SUTECBA_ENV=production
SUTECBA_TZ=America/Argentina/Buenos_Aires
SUTECBA_QR_SECRET=<el valor que generaste arriba>
# Si vas a usar Postgres real en vez de PGlite, descomentar y completar:
# SUTECBA_DATABASE_URL=postgres://usuario:password@localhost:5432/sutecba
```

## Paso 5 — Base de datos y usuario admin

```bash
npm run migrate
npm run seed
npm run create-admin -- --email=vos@ejemplo.com --name="Tu Nombre" --password="UnaContraseñaFuerte123!"
```

Guardá ese email/contraseña — es con lo que vos (o la persona a la que le des acceso completo) van a entrar. Si en vez de darle acceso al CRM entero solo querés mostrarle un formulario público o una invitación puntual, no hace falta crear más usuarios — esos links son públicos por diseño (`/f/tu-slug`, `/reunion/invitacion/...`).

## Paso 6 — Compilar

```bash
npm run build
```

## Paso 7 — Dejarlo corriendo con PM2

PM2 lo mantiene vivo, lo reinicia si se cae, y sobrevive a que cierres la sesión SSH.

```bash
sudo npm install -g pm2
pm2 start npm --name sutecba -- run start
pm2 save
pm2 startup    # va a imprimir un comando — copialo y correlo tal cual (una sola vez)
```

Esto deja el CRM escuchando en `127.0.0.1:3100` (el `-p 3100` ya está fijado en `package.json`, no hace falta repetirlo).

Comandos útiles después:

```bash
pm2 logs sutecba       # ver qué está pasando
pm2 restart sutecba    # reiniciar después de un cambio
pm2 stop sutecba       # apagarlo sin borrar nada
```

## Paso 8 — HTTPS sin dominio (nginx + certificado autofirmado)

```bash
sudo apt-get install -y nginx openssl
sudo mkdir -p /etc/nginx/ssl
sudo openssl req -x509 -nodes -days 825 -newkey rsa:2048 \
  -keyout /etc/nginx/ssl/sutecba.key \
  -out /etc/nginx/ssl/sutecba.crt \
  -subj "/CN=TU_IP" \
  -addext "subjectAltName=IP:TU_IP"
```

*(Reemplazá `TU_IP` por la IP pública real del VPS, en las dos apariciones.)*

Creá `/etc/nginx/sites-available/sutecba` (`sudo nano /etc/nginx/sites-available/sutecba`):

```nginx
server {
    listen 80;
    server_name _;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name _;

    ssl_certificate     /etc/nginx/ssl/sutecba.crt;
    ssl_certificate_key /etc/nginx/ssl/sutecba.key;

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

Activarlo:

```bash
sudo ln -s /etc/nginx/sites-available/sutecba /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## Paso 9 — Firewall

Solo 80/443 necesitan estar abiertos al mundo — el puerto 3100 queda interno, nginx es el único que le habla directo.

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable      # si todavía no estaba activo
sudo ufw status
```

## Paso 10 — El link

```
https://TU_IP/
```

El navegador de la persona va a avisar que el certificado no es de confianza (es autofirmado, esperable) — tiene que aceptar/continuar una vez. Después funciona normal: login con el usuario que creaste en el Paso 5, o directo a un link público (`/f/...`, `/reunion/...`) si es lo único que querés mostrar.

## Actualizar el código después de un cambio

```bash
# subís el tar.gz nuevo igual que en el Paso 1, después:
cd /opt/sutecba
npm install        # solo si cambiaron las dependencias
npm run build
pm2 restart sutecba
```

## Apagarlo del todo

```bash
pm2 delete sutecba
sudo rm /etc/nginx/sites-enabled/sutecba
sudo systemctl reload nginx
```

## Advertencias

- **PGlite en este VPS es tan descartable como en tu máquina** — un `kill -9`/reinicio abrupto del proceso puede corromper `.data/pglite-local` (mismo hallazgo documentado en `SUTECBA_DATABASE.md`). Para un demo de unos días no es grave (se recrea en un minuto con `migrate`+`seed`+`create-admin`), pero no lo dejes así con datos reales de afiliados por tiempo prolongado — en ese punto conviene pasar a un Postgres real.
- El certificado autofirmado no reemplaza uno real: sirve para que el tráfico viaje cifrado y el login funcione, no para que el navegador confíe en el sitio sin advertencia. Si esto se vuelve permanente, en algún momento va a valer la pena un dominio + Let's Encrypt (gratis, sin la advertencia).
- No compartas el `.env` ni el certificado/clave privada (`sutecba.key`) fuera del VPS.
