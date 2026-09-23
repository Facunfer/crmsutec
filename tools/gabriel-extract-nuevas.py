"""
Extractor de las NUEVAS bases de Gabriel (2026-09-21): 8 PDF que viven FUERA de Git.

    python tools/gabriel-extract-nuevas.py <carpeta_con_los_pdf> <carpeta_salida>

Para cada PDF escribe <codigo>.json con la misma forma que tools/gabriel-extract.py
({fileCode, fileName, sha256, sizeBytes, sheets:[{name, rows:[{n, cells}]}]}). Si la carpeta trae MANIFEST.json
(con SHA-256 por archivo) se verifica cada hash y se ABORTA ante cualquier diferencia. Las salidas contienen datos
personales: quedan fuera de Git y no se imprimen.

Dependencia: pymupdf (fitz).
"""
import hashlib
import json
import os
import sys
import unicodedata

def _norm(s):
    return unicodedata.normalize("NFC", s).lower()


# (código, prefijo del nombre normalizado). Se identifican por prefijo para tolerar variantes de codificación del nombre.
FILES = [
    ("N01", "padrón pg"),
    ("N02", "oftalmo teatro colón"),
    ("N03", "oftalmo ss. trabajo"),
    ("N04", "oftalmo ivc"),
    ("N05", "oftalmo cruz malta"),
    ("N06", "oftalmo centro metropolitano"),
    ("N07", "oftalmo canale"),
    ("N08", "oftalmo asi"),
]


def cell_value(v):
    if v is None:
        return None
    s = str(v).replace("\n", " ").strip()
    return s if s != "" else None


def trim(cells):
    out = list(cells)
    while out and out[-1] is None:
        out.pop()
    return out


def read_pdf(path):
    import fitz

    doc = fitz.open(path)
    sheets = []
    for pno, page in enumerate(doc, start=1):
        for tno, table in enumerate(page.find_tables().tables, start=1):
            rows = []
            for i, row in enumerate(table.extract(), start=1):
                cells = trim([cell_value(c) for c in row])
                if any(c is not None for c in cells):
                    rows.append({"n": i, "cells": cells})
            sheets.append({"name": f"p{pno}" + (f"-t{tno}" if tno > 1 else ""), "rows": rows})
    return sheets


def main(src_dir, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    manifest = {}
    mpath = os.path.join(src_dir, "MANIFEST.json")
    if os.path.exists(mpath):
        raw = json.load(open(mpath, encoding="utf-8"))
        entries = raw.get("files", raw) if isinstance(raw, dict) else raw
        if isinstance(entries, dict):
            manifest = {_norm(k): v for k, v in entries.items()}
        else:
            for e in entries:
                manifest[_norm(e.get("name") or e.get("file") or e.get("fileName") or "")] = e.get("sha256")
    present = {_norm(f): f for f in os.listdir(src_dir) if f.lower().endswith(".pdf")}
    missing = []
    for code, prefix in FILES:
        match = [orig for norm, orig in present.items() if norm.startswith(prefix)]
        if len(match) != 1:
            missing.append(f"{code} ({prefix}): {len(match)} coincidencias")
            continue
        name = match[0]
        path = os.path.join(src_dir, name)
        blob = open(path, "rb").read()
        sha = hashlib.sha256(blob).hexdigest()
        expected = manifest.get(_norm(name))
        if manifest and expected and expected.lower() != sha:
            raise SystemExit(f"[extract] {code}: el SHA-256 NO coincide con MANIFEST.json. Se aborta.")
        sheets = read_pdf(path)
        payload = {"fileCode": code, "fileName": name, "sha256": sha, "sizeBytes": len(blob), "sheets": sheets}
        with open(os.path.join(out_dir, f"{code}.json"), "w", encoding="utf-8") as out:
            json.dump(payload, out, ensure_ascii=False)
        total = sum(len(s["rows"]) for s in sheets)
        print(f"[extract] {code}: {len(sheets)} tabla(s), {total} filas -> {code}.json | manifest: {'verificado' if manifest and expected else 'sin MANIFEST'}")
    if missing:
        raise SystemExit("[extract] Faltan / son ambiguos: " + "; ".join(missing))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])
