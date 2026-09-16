# Desplegar SUTECBA en tu VPS de Hostinger, sin dominio, con usuario y contraseña

> Adaptado a tu VPS real: `srv1457428.hstgr.cloud`, IP `145.223.92.253`, Ubuntu 24.04 LTS, acceso `root`. Vas a hacer todo esto vos, desde el botón **Web console** del panel de Hostinger (te deja directo en una terminal como `root`, sin necesidad de contraseña SSH aparte). No toco el VPS desde esta sesión — no tengo acceso a él.

## Qué vas a lograr

El CRM corriendo en `https://145.223.92.253/`, con un usuario y contraseña que le das a la persona que lo va a mirar — sin dominio, sin esperar nada.

**Por qué HTTPS y no HTTP plano**: la cookie de sesión se marca `Secure` en producción a propósito. Los navegadores **ignoran** una cookie `Secure` si la conexión es HTTP plano — el login parecería andar (redirige) pero la sesión nunca queda guardada, y termina en un loop de "iniciá sesión de nuevo". Un certificado autofirmado resuelve esto sin tocar código: el navegador de la persona va a avisar "conexión no segura" — tiene que aceptar una vez, es esperable sin dominio, no es un error.

**Cómo sube el código sin usar `scp`**: como vas a trabajar solo desde la consola web (sin transferencia de archivos directa desde tu Windows), la forma correcta es subir el código a un repositorio de GitHub primero, y clonarlo desde el VPS. De paso, actualizar más adelante queda mucho más simple (`git pull` en vez de repetir todo).

## Paso 0 — Subir el código a GitHub (desde tu máquina Windows)

1. Andá a [github.com/new](https://github.com/new) y creá un repositorio **privado** (por ejemplo `sutecba-crm`). No lo inicialices con README ni nada — dejalo vacío.
2. En Git Bash, parado en `C:\Users\usuario\Downloads\sutecba`:

```bash
git remote add origin https://github.com/TU_USUARIO/sutecba-crm.git
git push -u origin master
```

Te va a pedir usuario/contraseña de GitHub — si tenés verificación en dos pasos (lo normal hoy), en vez de tu contraseña usá un **token de acceso personal**: [github.com/settings/tokens](https://github.com/settings/tokens) → "Generate new token (classic)" → marcá el scope `repo` → generar → copiar ese token y pegarlo como si fuera la contraseña cuando Git te la pida.

## Paso 1 — Consola web y clonar el repo

En el panel de Hostinger, click en **Web console**. Ya estás como `root` en el VPS.

Para clonar un repo **privado**, generá otro token igual que en el Paso 0 (podés reusar el mismo) y:

```bash
git clone https://TU_USUARIO:TU_TOKEN@github.com/TU_USUARIO/sutecba-crm.git /opt/sutecba
cd /opt/sutecba
```

*(El token queda en el historial de bash de este VPS. Si te preocupa, después de clonar corré `history -c` y considerá revocar el token en GitHub una vez que termines — para actualizaciones futuras podés generar uno nuevo, o configurar una clave SSH de despliegue.)*

## Paso 2 — Node.js

```bash
node --version
```

Si no aparece nada o es una versión vieja:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
```

## Paso 3 — Instalar dependencias del proyecto

```bash
cd /opt/sutecba
npm install
```

## Paso 4 — Variables de entorno de producción

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Copiá el valor que imprime y editá el archivo:

```bash
nano .env
```

Dejalo así (pegando tu valor generado en `SUTECBA_QR_SECRET`):

```
SUTECBA_ENV=production
SUTECBA_TZ=America/Argentina/Buenos_Aires
SUTECBA_QR_SECRET=<el valor que generaste arriba>
```

Guardar en `nano`: `Ctrl+O`, `Enter`, `Ctrl+X`.

*(Se usa PGlite, el mismo motor embebido que en tu máquina — no hace falta instalar Postgres para esto. Ver advertencia al final sobre sus límites.)*

## Paso 5 — Base de datos y el usuario para la persona que va a mirar

```bash
npm run migrate
npm run seed
npm run create-admin -- --email=persona@ejemplo.com --name="Nombre de la persona" --password="UnaContraseñaFuerte123!"
```

Ese email/contraseña es lo que le vas a dar a la persona para entrar — le va a pedir cambiarla la primera vez que ingrese. Si en cambio solo querés mostrarle un formulario público puntual, no hace falta esto: esos links son públicos por diseño (`/f/tu-slug`).

## Paso 6 — Compilar

```bash
npm run build
```

## Paso 7 — Dejarlo corriendo con PM2

```bash
npm install -g pm2
pm2 start npm --name sutecba -- run start
pm2 save
pm2 startup
```

El último comando (`pm2 startup`) imprime otro comando — copialo tal cual y correlo (para que sobreviva a un reinicio del VPS).

Comandos útiles después:

```bash
pm2 logs sutecba
pm2 restart sutecba
pm2 stop sutecba
```

## Paso 8 — HTTPS sin dominio (nginx + certificado autofirmado)

```bash
apt-get install -y nginx openssl
mkdir -p /etc/nginx/ssl
openssl req -x509 -nodes -days 825 -newkey rsa:2048 \
  -keyout /etc/nginx/ssl/sutecba.key \
  -out /etc/nginx/ssl/sutecba.crt \
  -subj "/CN=145.223.92.253" \
  -addext "subjectAltName=IP:145.223.92.253"
```

Creá la config:

```bash
nano /etc/nginx/sites-available/sutecba
```

Pegá esto tal cual (ya con tu IP):

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

Activarla:

```bash
ln -s /etc/nginx/sites-available/sutecba /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx
```

## Paso 9 — Firewall

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
ufw status
```

*(Si `ufw` pide confirmación al activarlo, respondé `y`. Ojo con no bloquear el puerto 22/SSH — por eso el `allow OpenSSH` va primero.)*

## Paso 10 — El link para la persona

```
https://145.223.92.253/
```

Le compartís ese link + el email/contraseña del Paso 5. El navegador le va a avisar que el certificado no es de confianza — tiene que aceptar/continuar una vez, después funciona normal.

## Actualizar el código después de un cambio

Desde tu Windows: `git push` al mismo repo. En el VPS:

```bash
cd /opt/sutecba
git pull
npm install        # solo si cambiaron las dependencias
npm run build
pm2 restart sutecba
```

## Apagarlo del todo

```bash
pm2 delete sutecba
rm /etc/nginx/sites-enabled/sutecba
systemctl reload nginx
```

## Advertencias

- **PGlite acá es tan descartable como en tu máquina** — un corte abrupto del proceso puede corromper los datos (mismo hallazgo documentado en `SUTECBA_DATABASE.md`). Para que alguien lo mire unos días no es grave (se recrea en un minuto repitiendo el Paso 5), pero no lo dejes así con datos reales de afiliados por mucho tiempo — ahí conviene un Postgres real (`SUTECBA_DATABASE_URL`, el código ya lo soporta sin cambios).
- El certificado autofirmado no reemplaza uno real: cifra el tráfico y hace que el login funcione, pero el navegador no va a confiar en el sitio sin avisar. Si esto se vuelve permanente, en algún momento conviene un dominio + Let's Encrypt (gratis, sin la advertencia).
- No compartas el `.env`, el token de GitHub ni la clave privada (`sutecba.key`) fuera del VPS.
