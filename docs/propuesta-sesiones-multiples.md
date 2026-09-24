# Propuesta futura: dos sesiones reales e independientes en pestañas distintas del mismo navegador

Estado: **propuesta, no implementada**. Decisión 2026-09-24: por ahora se usa la alternativa A (perfiles de
navegador / ventana de incógnito separados) — ver [cambios-area-reparticion-semaforo-y-nuevas-bases.md](./cambios-area-reparticion-semaforo-y-nuevas-bases.md)
y la sesión de trabajo del mismo día. Este documento deja registrado el problema y el camino posible para el día que
haga falta resolverlo sin recurrir a perfiles separados.

## El problema

[lib/auth/cookies.ts](../lib/auth/cookies.ts) usa una única cookie (`sutecba_session`, `path=/`, `httpOnly`,
`sameSite=lax`). Una cookie con ese alcance es del **navegador**, no de la pestaña: todas las pestañas del mismo
origen la comparten. Abrir Master Global en una pestaña y Cultura en otra termina en que la segunda sobreescribe la
sesión de la primera. Esto no es un bug de SUTECBA: es una propiedad de cómo funcionan las cookies en cualquier
navegador, y afecta a cualquier app que autentique así (que es casi cualquier app con `httpOnly` cookies, por buenos
motivos de seguridad — ver la sección de restricciones más abajo).

## Restricciones que cualquier solución debe respetar

Estas vienen de la decisión del 2026-09-24 y no son negociables sin una decisión de negocio nueva:

- **Nada de tokens en `localStorage`/`sessionStorage`.** Son accesibles por JavaScript, así que cualquier XSS en la
  app (o en una dependencia de terceros) podría robar el token de sesión directamente. `httpOnly` existe exactamente
  para evitar esto — cambiar a storage inseguro sería un retroceso de seguridad real, no cosmético.
- **No debilitar la autenticación.** Nada de "modo demo", tokens de larga duración sin control, ni saltarse
  `permissions_version`/expiración/revocación (ver [lib/auth/session.ts](../lib/auth/session.ts)).
  - **No introducir un mecanismo que permita eludir scopes.** Cualquier forma de "elegir con qué identidad opero en
  esta pestaña" tiene que seguir resolviendo permisos y alcance exactamente como hoy — nunca un atajo que un usuario
  pueda usar para verse a sí mismo con más acceso del que realmente tiene.

## Camino técnico viable

Web Locks API / `BroadcastChannel` no resuelven esto (son para coordinar pestañas de una MISMA sesión, no para tener
dos sesiones distintas). La única forma real de que dos pestañas del mismo navegador mantengan **cada una su propia
sesión autenticada**, sin tocar `localStorage`/`sessionStorage` para el token, es que el servidor deje de identificar
la sesión SOLO por el nombre de la cookie y empiece a aceptar **múltiples sesiones concurrentes**, seleccionadas por
algo que sí puede variar por pestaña: la URL.

Diseño posible (no implementado, para evaluar cuando se decida encarar):

1. **Multi-sesión en cookie**: en vez de una cookie `sutecba_session` con un solo token, guardar varias — p. ej.
   `sutecba_sessions` con una lista `{sessionId, tokenHash}[]` firmada, o una cookie por sesión con nombre
   `sutecba_session_<sessionId>`. Todas siguen siendo `httpOnly`; el token nunca lo toca JavaScript.
2. **Selector de sesión activa por URL**, no por cookie**: cada pestaña navega con un segmento o query param que
   identifica CUÁL de las sesiones guardadas usar en ese request (p. ej. `/s/<sessionId>/dashboard`). El middleware y
   `getSessionUser()` (hoy en [lib/auth/guard.ts](../lib/auth/guard.ts)) leerían el `sessionId` de la URL, buscarían
   ESA cookie específica entre las varias guardadas, y validarían exactamente como hoy (`loadSessionUser`, sin
   cambios en la lógica de expiración/revocación/permissions_version).
3. **Pantalla de "sesiones activas en este navegador"**: al loguearse con una cuenta distinta mientras ya hay una
   sesión activa, en vez de pisarla, se agrega como una sesión más; el usuario elige entre ellas (cambiar de pestaña
   activa) desde un selector simple en el header.
4. Esto es un cambio de fondo en el modelo de autenticación (no una feature aislada): toca middleware, cookies,
   guard, cada Server Action que lee la sesión, y probablemente logout (¿cierra una sesión o todas?). Antes de
   encararlo hace falta decidir explícitamente el comportamiento de logout, el límite de sesiones simultáneas por
   navegador, y qué pasa si dos pestañas abren la MISMA cuenta dos veces.

## Alternativa más simple si алcanza con "ver, no operar"

Si en algún momento lo que hace falta es solo *previsualizar* qué ve un scope sin necesitar dos sesiones reales
escribiendo al mismo tiempo, la alternativa B que se descartó por ahora (función "Ver como" de solo lectura para
Master Global, con el estado en la URL/`sessionStorage` por pestaña, sin sesión nueva) sigue siendo la opción más
barata — ver la conversación del 2026-09-24 para el diseño completo. Es más simple que lo de arriba porque no
requiere sesiones concurrentes de verdad, pero tampoco reproduce el comportamiento exacto de la cuenta real (módulos
habilitados, etc.).
