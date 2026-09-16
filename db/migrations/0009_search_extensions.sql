-- Separado de la creación del índice (migración 0010) a propósito: PGlite
-- no deja visibles las funciones de una extensión recién creada dentro de
-- la misma transacción en la que se usan para una expresión indexada.
create extension if not exists pg_trgm;
create extension if not exists unaccent;
