# Decisiones del catálogo organizacional (complementa `Decisiones_V2`)

Fuente: `SUTECBA_Estructura_Oficial_Alias_Gabriel_v2.xlsx`. Confirmadas por SUTECBA el 2026-09-21.

| Decisión | Resultado | Criterio |
|---|---|---|
| `UNIDAD DE AUDITORIA INTERNA` en el Padrón PG (F07) — 12 apariciones | **`UAIPG` — Unidad de Auditoría Interna PG** (contexto de archivo). Reemplaza la homologación V2 a `UAISGCBA`, que era incorrecta. | El Padrón PG es un padrón de Procuración General. La regla sigue siendo contextual: `UAI` sola NO significa siempre `UAIPG`; fuera del Padrón PG, sin otro contexto, queda sin resolver. |
| `DGTAL` / `DG TECNICA ADMINISTRATIVA Y LEGAL` | **Nunca alias global.** Se resuelve por jurisdicción: Cultura → `DGTALMC`, Hacienda → `DGTALMHF`, Seguridad → `DGTALMSE`, Procuración → `DGTALPG`, ASINF → `DGTALINF`. | Son unidades oficiales distintas con el mismo nombre genérico. La persona queda en la unidad más específica oficialmente comprobada (no en el ministerio). |
| Contexto embebido en el texto (`dgtal hacienda`, `Dgtal MINISTERIO DE HACIENDA Y FINANZAS`) | Se resuelve por descomposición determinística con aliases exactos (denominación genérica de una familia + una jurisdicción conocida). | Sin coincidencias aproximadas. Dos jurisdicciones → `ORGANISM_CONTEXT_CONFLICT`; ninguna → contexto insuficiente; más de una interpretación → no se resuelve. |

## Familias de homónimos

El algoritmo (`lib/organizations/catalog/homonyms.ts`) detecta como familia a todo grupo de ≥ 2 unidades del mismo tipo con el mismo nombre genérico (o con el código del padre como sufijo) y padres distintos. **Las familias detectadas son las del catálogo oficial actualmente cargado** (hoy: DGTAL, «DG Técnica y Administrativa» y Unidad de Auditoría Interna); no es una lista exhaustiva de todas las unidades de GCBA. Al agregar organizaciones oficiales, las nuevas familias se detectan solas.
