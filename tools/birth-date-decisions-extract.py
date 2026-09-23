"""
Pasa la hoja "birth_dates_revision" de birth_dates_historicas_revision.xlsx (ya completada por una persona) a JSON
crudo, para scripts/fix-birth-dates.ts.

    python tools/birth-date-decisions-extract.py <birth_dates_historicas_revision.xlsx> <salida.json>

NO valida nada mas alla de que existan las columnas: la validacion estricta (decision permitida, fecha requerida
segun la decision, DNI conocido) la hace lib/people/birth-date-decisions.ts. La salida contiene DNI y fechas de
nacimiento: dejarla fuera de Git y no imprimirla.
"""
import hashlib
import json
import os
import sys

import openpyxl


def main(src, out):
    wb = openpyxl.load_workbook(src, data_only=True)
    ws = wb["birth_dates_revision"]
    rows = list(ws.iter_rows(values_only=True))
    header_index = next(i for i, r in enumerate(rows) if r and "Decisión" in [str(c).strip() if c is not None else "" for c in r])
    header = [str(c).strip() if c is not None else "" for c in rows[header_index]]
    keep = {
        "DNI": "dni",
        "birth_date actual (Supabase)": "birth_date_actual_supabase",
        "Fecha candidata": "fecha_candidata",
        "Decisión": "decision",
        "Notas": "notas",
    }
    missing = [h for h in keep if h not in header]
    if missing:
        raise SystemExit(f"Faltan columnas en la hoja birth_dates_revision: {missing}")
    idx = {keep[h]: header.index(h) for h in keep}
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
