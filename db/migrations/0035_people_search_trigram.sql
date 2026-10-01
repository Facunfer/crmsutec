BEGIN;

-- Falla rápido (no bloquea la aplicación esperando) si otra transacción larga retiene un lock sobre people/la función.
SET LOCAL lock_timeout = '10s';

-- 0035 — Búsqueda de personas (etapa 1, parte B): índices trigram para `ILIKE '%término%'`.
--
-- La búsqueda del listado es una subcadena sobre 5 columnas (nombre, apellido/nombre completo de los `unsplit`, DNI, email,
-- teléfono). Sin estos índices cada búsqueda recorre las 179.631 personas (~300 ms). Son GIN con gin_trgm_ops (pg_trgm está
-- instalada desde 0009). Tamaños medidos sobre el volumen real: first_name 0,4 MB, last_name 10 MB, dni 5,5 MB, email 0,9 MB,
-- phone 0,5 MB. Términos de 1–2 caracteres no usan trigram (recorrido completo, igual que antes).

CREATE INDEX IF NOT EXISTS people_first_name_trgm_idx ON public.people USING gin (first_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS people_last_name_trgm_idx ON public.people USING gin (last_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS people_dni_trgm_idx ON public.people USING gin (dni gin_trgm_ops);
CREATE INDEX IF NOT EXISTS people_email_trgm_idx ON public.people USING gin (email gin_trgm_ops);
CREATE INDEX IF NOT EXISTS people_phone_trgm_idx ON public.people USING gin (phone gin_trgm_ops);

COMMIT;
