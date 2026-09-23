"""
Pasa la hoja «Identidades» de gabriel_identidades_bloqueadas.xlsx (ya completada por una persona) a JSON crudo.

    python tools/identity-decisions-extract.py <gabriel_identidades_bloqueadas.xlsx> <salida.json>

NO valida nada: la validación estricta (valores permitidos, nombres canónicos obligatorios para MERGE_SAME_PERSON,
DNI = exactamente los bloqueados) la hace lib/imports/gabriel/identity-decisions.ts. La salida contiene DNI: dejarla
fuera de Git y no imprimirla.
"""
import hashlib
import json
import os
import sys

import openpyxl


def main(src, out):
    wb = openpyxl.load_workbook(src, data_only=True)
    ws = wb["Identidades"]
    rows = list(ws.iter_rows(values_only=True))
    # La hoja tiene una fila de nota arriba: el encabezado es la primera fila que contiene «decision».
    header_index = next(i for i, r in enumerate(rows) if r and "decision" in [str(c).strip() if c is not None else "" for c in r])
    header = [str(c).strip() if c is not None else "" for c in rows[header_index]]
    keep = {"DNI": "dni", "decision": "decision", "canonical_first_name": "canonical_first_name", "canonical_last_name": "canonical_last_name", "notes": "notes"}
    idx = {keep[h]: header.index(h) for h in keep if h in header}
    missing = [h for h in keep if h not in header]
    if missing:
        raise SystemExit(f"Faltan columnas en la hoja Identidades: {missing}")
    data = []
    for r in rows[header_index + 1:]:
        if r is None or all(c is None or str(c).strip() == "" for c in r):
            continue
        data.append({k: (None if r[i] is None else str(r[i]).strip()) for k, i in idx.items()})
    with open(out, "w", encoding="utf-8") as f:
        sha = hashlib.sha256(open(src, "rb").read()).hexdigest()
        json.dump({"source_file": os.path.basename(src), "source_sha256": sha, "rows": data}, f, ensure_ascii=False)
    print({"filas": len(data)})


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
