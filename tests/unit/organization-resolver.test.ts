import { describe, expect, it } from "vitest";
import { buildPlan } from "../../lib/imports/gabriel/plan.js";
import { OrganizationResolver } from "../../lib/imports/gabriel/organization-resolver.js";
import { cuilFor, f07File, f09File, f10File } from "../helpers/gabriel-fixtures.js";

/**
 * Jerarquía de prueba (ids = claves): dos ministerios y una dependencia; cada uno con su DGTAL y su UAI homónimas,
 * más una Subsecretaría con su propia unidad dentro de Cultura.
 *
 *   MC ─┬─ DGTAL_MC      MH ── DGTAL_MH      PG ── DGTAL_PG
 *       ├─ UAI_MC        (UAI solo en MC y PG)     └─ UAI_PG
 *       └─ SSPAT ── DGPAT
 */
const parents = new Map<string, string | null>([
  ["MC", null], ["MH", null], ["PG", null],
  ["DGTAL_MC", "MC"], ["DGTAL_MH", "MH"], ["DGTAL_PG", "PG"],
  ["UAI_MC", "MC"], ["UAI_PG", "PG"], ["IDECBA", null], ["UAI_IDECBA", "IDECBA"],
  ["SSPAT", "MC"], ["DGPAT", "SSPAT"],
]);
const aliases = [
  // globales
  { alias: "Cultura", organizationId: "MC" },
  { alias: "Ministerio de Cultura", organizationId: "MC" },
  { alias: "Hacienda", organizationId: "MH" },
  { alias: "Procuración General", organizationId: "PG" },
  { alias: "Procuración", organizationId: "PG" },
  { alias: "Ministerio de Hacienda y Finanzas", organizationId: "MH" },
  { alias: "de Cultura", organizationId: "MC" },
  { alias: "IDECBA", organizationId: "IDECBA" },
  { alias: "Patrimonio", organizationId: "DGPAT" },
  // contextuales: DGTAL y UAI (mismo mecanismo, sin excepciones por nombre)
  { alias: "DGTAL", organizationId: "DGTAL_MC", contextOrganizationId: "MC" },
  { alias: "DGTAL", organizationId: "DGTAL_MH", contextOrganizationId: "MH" },
  { alias: "DGTAL", organizationId: "DGTAL_PG", contextOrganizationId: "PG" },
  { alias: "UAI", organizationId: "UAI_MC", contextOrganizationId: "MC" },
  { alias: "UAI", organizationId: "UAI_PG", contextOrganizationId: "PG" },
  { alias: "UAI", organizationId: "UAI_IDECBA", contextOrganizationId: "IDECBA" },
];
const resolver = (over: Record<string, unknown> = {}) => new OrganizationResolver({ aliases, parentOf: parents, fileJurisdictions: { F07: "PG" }, ...over } as never);

describe("resolución directa (global, contexto de fila, contexto de archivo)", () => {
  it("un alias global resuelve solo, sin contexto", () => {
    expect(resolver().resolveDirect("cultura", "F09")).toEqual({ status: "resolved", organizationId: "MC", kind: "global", contextOrganizationId: null });
    expect(resolver().resolveDirect("MINISTERIO DE CULTURA", "F06")).toMatchObject({ organizationId: "MC", kind: "global" });
  });

  it("un alias homónimo NO se resuelve globalmente: pide contexto", () => {
    const r = resolver().resolveDirect("DGTAL", "F09");
    expect(r.status).toBe("needs_context");
    expect(resolver().resolveDirect("UAI", "F06").status).toBe("needs_context");
  });

  it("Prioridad 1 — contexto explícito de la misma fila: «Cultura / DGTAL» → DGTAL de Cultura", () => {
    for (const [text, org] of [["Cultura / DGTAL", "DGTAL_MC"], ["Hacienda | DGTAL", "DGTAL_MH"], ["DGTAL - Procuración General", "DGTAL_PG"], ["UAI / Cultura", "UAI_MC"]] as const) {
      expect(resolver().resolveDirect(text, "F06")).toEqual({ status: "resolved", organizationId: org, kind: "row_context", contextOrganizationId: expect.any(String) });
    }
  });

  it("el contexto de fila sirve si la unidad de evidencia está DENTRO del contexto (ancestro)", () => {
    // «Patrimonio» (DGPAT, dentro de Cultura) + DGTAL → DGTAL de Cultura.
    expect(resolver().resolveDirect("Patrimonio / DGTAL", "F06")).toMatchObject({ organizationId: "DGTAL_MC", kind: "row_context", contextOrganizationId: "MC" });
  });

  it("una jurisdicción sin esa unidad NO inventa la resolución (UAI + Hacienda: no existe UAI de Hacienda)", () => {
    expect(resolver().resolveDirect("Hacienda / UAI", "F06").status).toBe("needs_context");
  });

  it("Prioridad 2 — archivo de una sola jurisdicción: Padrón PG resuelve DGTAL y UAI a Procuración", () => {
    expect(resolver().resolveDirect("DGTAL", "F07")).toMatchObject({ organizationId: "DGTAL_PG", kind: "file_context", contextOrganizationId: "PG" });
    expect(resolver().resolveDirect("uai", "F07")).toMatchObject({ organizationId: "UAI_PG", kind: "file_context" });
  });

  it("un archivo con varias jurisdicciones (sin mapa de archivo) NO aporta contexto: la misma cadena en otro archivo no cae en Procuración", () => {
    expect(resolver().resolveDirect("DGTAL", "F06").status).toBe("needs_context");
    expect(resolver().resolveDirect("DGTAL", "F10").status).toBe("needs_context");
  });

  it("un texto desconocido, un área laboral libre o un separador sin nada resoluble quedan sin resolver", () => {
    for (const text of ["Compras", "Sistemas", "RRHH", "Administración", "Compras / Sistemas", "Compras / DGTAL"]) {
      expect(["unmapped", "needs_context"]).toContain(resolver().resolveDirect(text, "F06").status);
      expect(resolver().resolveDirect(text, "F06").status).not.toBe("resolved");
    }
  });

  it("un global no puede hacer sombra a un contextual: el mismo texto con ambos es ambiguo", () => {
    const r = new OrganizationResolver({ aliases: [...aliases, { alias: "DGTAL", organizationId: "DGTAL_MC" }], parentOf: parents });
    expect(r.resolveDirect("DGTAL", "F09").status).toBe("ambiguous");
  });
});

describe("Prioridad 1 — contexto EMBEBIDO en el texto, sin separadores (descomposición determinística por alias exactos)", () => {
  const embedded = (text: string, file: any = "F06") => resolver().resolveDirect(text, file);
  const ok = (text: string, org: string, file: any = "F06") =>
    expect(embedded(text, file)).toMatchObject({ status: "resolved", organizationId: org, kind: "embedded_context" });

  it("«dgtal hacienda» → DGTAL de Hacienda; «Dgtal MINISTERIO DE HACIENDA Y FINANZAS» → DGTAL de Hacienda", () => {
    ok("dgtal hacienda", "DGTAL_MH");
    ok("Dgtal MINISTERIO DE HACIENDA Y  FINANZAS", "DGTAL_MH");
    ok("DGTAL MINISTERIO DE HACIENDA Y FINANZAS", "DGTAL_MH");
  });

  it("otros ejemplos: DGTAL Ministerio de Cultura, UAI Procuracion, UAI IDECBA, orden invertido y conectores", () => {
    ok("DGTAL Ministerio de Cultura", "DGTAL_MC"); // «Ministerio de Cultura» es un alias exacto (y también «de Cultura»): mismo resultado con ambas coberturas
    ok("UAI Procuracion", "UAI_PG");
    ok("UAI IDECBA", "UAI_IDECBA");
    ok("Hacienda DGTAL", "DGTAL_MH");
    ok("DGTAL de Hacienda", "DGTAL_MH");
    ok("dgtal   HACIENDA", "DGTAL_MH");
  });

  it("el contexto del propio texto manda sobre el del archivo: «dgtal hacienda» en el Padrón PG es Hacienda, no Procuración", () => {
    ok("dgtal hacienda", "DGTAL_MH", "F07");
    // Y la denominación sola en el Padrón PG sigue siendo Procuración (contexto de archivo).
    expect(embedded("DGTAL", "F07")).toMatchObject({ organizationId: "DGTAL_PG", kind: "file_context" });
  });

  it("«DGTAL» sola en un archivo mixto → sin resolver (contexto insuficiente)", () => {
    expect(embedded("DGTAL", "F06").status).toBe("needs_context");
    expect(embedded("dgtal", "F09").status).toBe("needs_context");
  });

  it("dos jurisdicciones distintas en el texto («DGTAL Cultura Hacienda») → conflicto de contexto", () => {
    expect(embedded("DGTAL Cultura Hacienda")).toEqual({ status: "context_conflict" });
    expect(embedded("Cultura DGTAL Hacienda")).toEqual({ status: "context_conflict" });
  });

  it("no hay coincidencias aproximadas: palabras que ningún alias exacto explica, o una jurisdicción sin esa unidad, no resuelven", () => {
    expect(embedded("dgtal haciendas").status).not.toBe("resolved"); // typo: no es alias exacto
    expect(embedded("dgtal hacienda extra").status).not.toBe("resolved"); // sobra una palabra sin alias
    expect(embedded("dgtal compras").status).not.toBe("resolved"); // un área laboral no es contexto
    expect(embedded("uai hacienda").status).not.toBe("resolved"); // no existe UAI de Hacienda: no se completa con otra jurisdicción
    expect(embedded("dgtal uai cultura").status).toBe("ambiguous"); // dos denominaciones genéricas: no se elige
  });

  it("más de una interpretación posible → no se resuelve", () => {
    const r = new OrganizationResolver({
      aliases: [...aliases, { alias: "Cultura Hacienda", organizationId: "MH" }], // «cultura hacienda» como alias propio hacia Hacienda vs. Cultura + Hacienda
      parentOf: parents,
    });
    expect(r.resolveDirect("dgtal cultura hacienda", "F06").status).toBe("ambiguous");
  });

  it("las jurisdicciones jerárquicamente consistentes no son conflicto («DGTAL Cultura Patrimonio»)", () => {
    const r = new OrganizationResolver({ aliases, parentOf: parents });
    expect(r.resolveDirect("dgtal cultura patrimonio", "F06")).toMatchObject({ status: "resolved", organizationId: "DGTAL_MC", kind: "embedded_context" });
  });
});

describe("Prioridad 3 — contexto consistente de la misma persona", () => {
  const options = [
    { contextOrganizationId: "MC", organizationId: "DGTAL_MC" },
    { contextOrganizationId: "MH", organizationId: "DGTAL_MH" },
    { contextOrganizationId: "PG", organizationId: "DGTAL_PG" },
  ];

  it("evidencia de una sola jurisdicción → resuelve a la unidad homónima de esa jurisdicción", () => {
    expect(resolver().resolveByPersonEvidence(options, ["MC"])).toEqual({ status: "resolved", organizationId: "DGTAL_MC", kind: "person_context", contextOrganizationId: "MC" });
    expect(resolver().resolveByPersonEvidence(options, ["DGPAT"])).toMatchObject({ organizationId: "DGTAL_MC" }); // una unidad dentro de Cultura también es evidencia de Cultura
  });

  it("evidencia de dos jurisdicciones → conflicto de contexto, no elige", () => {
    expect(resolver().resolveByPersonEvidence(options, ["MC", "MH"])).toEqual({ status: "context_conflict" });
  });

  it("evidencia de una jurisdicción y de OTRA sin ese homónimo (contradictoria) → conflicto", () => {
    expect(resolver().resolveByPersonEvidence(options, ["MC", "OTRA"])).toEqual({ status: "context_conflict" });
  });

  it("sin evidencia, o con evidencia de una jurisdicción que no tiene esa unidad → sigue pidiendo contexto", () => {
    expect(resolver().resolveByPersonEvidence(options, []).status).toBe("needs_context");
    expect(resolver().resolveByPersonEvidence(options, ["OTRA"]).status).toBe("needs_context");
  });
});

describe("integrado en el plan de Gabriel", () => {
  const dni = "50100001";
  const plan = (files: any[], over: Record<string, unknown> = {}) =>
    buildPlan(files, { organizationAliases: aliases, organizationParents: parents, fileJurisdictions: { F07: "PG" }, ...over } as never);
  const person = (p: ReturnType<typeof plan>, d = dni) => p.people.toCreate.find((x) => x.dni === d)!;
  const codesOf = (p: ReturnType<typeof plan>) => p.rows.flatMap((r) => r.issues).map((i) => i.code);

  it("global: Cultura → MC (por alias global)", () => {
    const p = plan([f09File([{ last: "A", first: "A", dni, email: "a@example.com", organism: "Cultura" }])]);
    expect(person(p)).toMatchObject({ organizationId: "MC", organizationResolution: { kind: "global" } });
    expect(p.counts.organizacion_resuelta_global).toBe(1);
  });

  it("contexto de fila: «Cultura / DGTAL» → DGTAL_MC, y queda registrado como contextual en la fila", () => {
    const p = plan([f09File([{ last: "A", first: "A", dni, email: "a@example.com", organism: "Cultura / DGTAL" }])]);
    expect(person(p)).toMatchObject({ organizationId: "DGTAL_MC", organizationResolution: { kind: "row_context", contextOrganizationId: "MC" } });
    expect(p.rows.find((r) => r.personDni === dni)!.organization).toMatchObject({ organizationId: "DGTAL_MC", kind: "row_context" });
    expect(p.counts.organizacion_resuelta_por_contexto_de_fila).toBe(1);
  });

  it("contexto de archivo: DGTAL en el Padrón PG (F07) → DGTAL_PG; la misma cadena en un formulario (F09) NO", () => {
    const pg = plan([f07File([{ last: "A", first: "A", cuil: cuilFor(dni), organism: "DGTAL" }])]);
    expect(person(pg)).toMatchObject({ organizationId: "DGTAL_PG", organizationResolution: { kind: "file_context", contextOrganizationId: "PG" } });
    const cultura = plan([f09File([{ last: "A", first: "A", dni, email: "a@example.com", organism: "DGTAL" }])]);
    expect(person(cultura).organizationId).toBeNull();
    expect(person(cultura).organizationStatus).toBe("context_missing");
    expect(codesOf(cultura)).toContain("ORGANISM_UNMAPPED");
    expect(cultura.counts.organizacion_con_contexto_insuficiente).toBe(1);
  });

  it("contexto de persona: «Cultura» en una fuente y «DGTAL» sola en otra → DGTAL_MC (la más específica, no MC)", () => {
    const p = plan([
      f09File([{ last: "A", first: "A", dni, email: "a@example.com", organism: "Cultura" }]),
      f10File([{ last: "A", first: "A", cuil: cuilFor(dni) }]),
    ]);
    expect(person(p).organizationId).toBe("MC");
    const both = plan([
      f09File([{ last: "A", first: "A", dni, email: "a@example.com", organism: "Cultura" }]),
      f07File([{ last: "A", first: "A", cuil: cuilFor(dni), organism: "Administración" }]), // área libre: no es contexto
    ]);
    expect(person(both).organizationId).toBeNull(); // 'Administración' sin alias → conflicto con 'Cultura'
    // Con un archivo SIN mapa de jurisdicción, «DGTAL» sola se resuelve por la persona.
    const viaPerson = plan(
      [f09File([{ last: "A", first: "A", dni, email: "a@example.com", organism: "Cultura" }]), f07File([{ last: "A", first: "A", cuil: cuilFor(dni), organism: "DGTAL" }])],
      { fileJurisdictions: {} }
    );
    expect(person(viaPerson)).toMatchObject({ organizationId: "DGTAL_MC", organizationResolution: { kind: "person_context", contextOrganizationId: "MC" } });
    expect(viaPerson.counts.organizacion_resuelta_por_contexto_de_persona).toBe(1);
    expect(viaPerson.conflicts.filter((c) => c.field === "organism")).toHaveLength(0);
  });

  it("conflicto: Cultura + Hacienda + DGTAL sola → ORGANISM_CONTEXT_CONFLICT, sin autoasignar", () => {
    const p = plan(
      [
        f09File([{ last: "A", first: "A", dni, email: "a@example.com", organism: "Cultura" }]),
        f10File([{ last: "A", first: "A", cuil: cuilFor(dni) }]),
        f07File([{ last: "A", first: "A", cuil: cuilFor(dni), organism: "DGTAL" }]),
        f09File([{ last: "A", first: "A", dni, email: "a@example.com", organism: "Hacienda" }]),
      ],
      { fileJurisdictions: {} }
    );
    expect(codesOf(p)).toContain("ORGANISM_CONTEXT_CONFLICT");
    expect(person(p).organizationId).toBeNull();
    expect(person(p).organizationStatus).toBe("context_conflict");
    expect(p.counts.organizacion_con_conflicto_de_contexto).toBe(1);
  });

  it("jerarquía: Cultura + Patrimonio (dentro de Cultura) no es conflicto; se guarda la unidad más específica", () => {
    const p = plan([
      f09File([{ last: "A", first: "A", dni, email: "a@example.com", organism: "Cultura" }]),
      f07File([{ last: "A", first: "A", cuil: cuilFor(dni), organism: "Patrimonio" }]),
    ]);
    expect(p.conflicts.filter((c) => c.field === "organism")).toHaveLength(0);
    expect(person(p).organizationId).toBe("DGPAT");
  });

  it("jurisdicciones distintas sin relación jerárquica (Cultura y Hacienda) siguen siendo conflicto de organismo", () => {
    const p = plan([
      f09File([{ last: "A", first: "A", dni, email: "a@example.com", organism: "Cultura" }]),
      f07File([{ last: "A", first: "A", cuil: cuilFor(dni), organism: "Hacienda" }]),
    ]);
    expect(p.conflicts.filter((c) => c.field === "organism")).toHaveLength(1);
    expect(person(p).organizationId).toBeNull();
  });

  it("el mismo mecanismo resuelve UAI: Cultura / UAI → UAI_MC; UAI en el Padrón PG → UAI_PG; UAI sola → sin unidad", () => {
    expect(person(plan([f09File([{ last: "A", first: "A", dni, email: "a@example.com", organism: "Cultura / UAI" }])])).organizationId).toBe("UAI_MC");
    expect(person(plan([f07File([{ last: "A", first: "A", cuil: cuilFor(dni), organism: "UAI" }])])).organizationId).toBe("UAI_PG");
    expect(person(plan([f09File([{ last: "A", first: "A", dni, email: "a@example.com", organism: "UAI" }])])).organizationId).toBeNull();
  });

  it("contexto embebido en el plan: «dgtal hacienda» y «Dgtal MINISTERIO DE HACIENDA Y FINANZAS» → DGTAL_MH, contado como embebido", () => {
    const p = plan([
      f09File([{ last: "A", first: "A", dni, email: "a@example.com", organism: "dgtal hacienda" }, { last: "B", first: "B", dni: "50100002", email: "b@example.com", organism: "Dgtal MINISTERIO DE HACIENDA Y FINANZAS" }]),
    ]);
    expect(person(p)).toMatchObject({ organizationId: "DGTAL_MH", organizationResolution: { kind: "embedded_context", contextOrganizationId: "MH" } });
    expect(person(p, "50100002").organizationId).toBe("DGTAL_MH");
    expect(p.counts.organizacion_resuelta_por_contexto_embebido).toBe(2);
    expect(p.rows.find((r) => r.personDni === dni)!.organization).toMatchObject({ kind: "embedded_context" });
  });

  it("sin alias contextuales cargados, el plan se comporta como antes (todo sin unidad con incidencia)", () => {
    const p = buildPlan([f09File([{ last: "A", first: "A", dni, email: "a@example.com", organism: "Cultura / DGTAL" }])]);
    expect(person(p).organizationId).toBeNull();
    expect(codesOf(p)).toContain("ORGANISM_UNMAPPED");
  });
});
