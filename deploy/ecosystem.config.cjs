/**
 * PM2 — dos procesos independientes en el VPS (/opt/sutecba):
 *   - sutecba      : la aplicación Next.js (npm run start, puerto 3100).
 *   - sutecba-mail : el worker de Mailing (envía por Amazon SES y consume los eventos de SQS). NO expone puertos. Se lanza con
 *                    `node --import tsx scripts/mail-worker.ts` (equivale a `npm run mail:worker`, sin wrappers).
 *
 * Las variables (SUTECBA_DATABASE_URL, AWS_*, SES_*, MAIL_*, PUBLIC_BASE_URL) se leen del .env del directorio, igual que la app.
 *
 *   pm2 start deploy/ecosystem.config.cjs --only sutecba-mail
 *   pm2 save
 *
 * Un solo worker: la cuota diaria es global y el reclamo es seguro con varios, pero no hace falta más para 15.000/día.
 */
module.exports = {
  apps: [
    {
      name: "sutecba",
      cwd: "/opt/sutecba",
      script: "npm",
      args: "run start",
      env: { NODE_ENV: "production" },
    },
    {
      name: "sutecba-mail",
      cwd: "/opt/sutecba",
      // Lanzador DIRECTO (sin npm ni el wrapper de tsx): un único proceso `node --import tsx`, así PM2 le manda SIGTERM al worker
      // mismo y este hace un apagado limpio (deja de reclamar, termina el ciclo en vuelo, retira su latido) antes de kill_timeout.
      script: "scripts/mail-worker.ts",
      interpreter: "node",
      interpreter_args: "--import tsx",
      env: { NODE_ENV: "production" },
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      kill_timeout: 30000,
    },
  ],
};
