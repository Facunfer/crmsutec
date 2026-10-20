BEGIN;

SET LOCAL lock_timeout = '10s';

-- 0047 — Permiso `meetings.accredit` (hallazgo S6 de la Fase F0). ADITIVA e idempotente.
--
-- Hasta ahora el QR operativo de una reunión y la búsqueda de personas para acreditar se obtenían con `meetings.view`, que
-- tiene hasta el rol LECTURA: un usuario de solo lectura podía emitir QR válidos de check-in y consultar personas. El permiso
-- nuevo separa «ver la reunión» de «operar la acreditación».
--
-- Matriz (lib/permissions/catalog.ts es la fuente; el seed la reconcilia con lo mismo, así que esta migración y `npm run seed`
-- convergen al mismo estado):
--   MASTER_GLOBAL, ADMIN, OPERADOR, REUNIONES -> SÍ  (hoy ya operan la acreditación: nadie pierde lo que usa)
--   LECTURA                                  -> NO  (solo mira; deja de poder emitir el QR y buscar para acreditar)
-- Ningún dato cambia; no se tocan usuarios, sesiones ni `permissions_version` (los permisos se leen del rol en cada pedido).
--
-- Rollback: DELETE FROM role_permissions de ese permiso y luego DELETE FROM permissions WHERE key = 'meetings.accredit'
-- (solo después de volver al código anterior, que no lo pide).

INSERT INTO public.permissions (key, description, module_key)
VALUES ('meetings.accredit', 'Acreditar asistentes: ver el QR operativo y buscar personas para el check-in', 'reuniones')
ON CONFLICT (key) DO UPDATE
  SET description = EXCLUDED.description,
      module_key = EXCLUDED.module_key;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.key = 'meetings.accredit'
WHERE r.key IN ('MASTER_GLOBAL', 'ADMIN', 'OPERADOR', 'REUNIONES')
ON CONFLICT (role_id, permission_id) DO NOTHING;

COMMIT;
