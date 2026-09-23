import { describe, expect, it } from "vitest";
import { aliasKey, aliasKeyForDb, buildCatalogPlan, planCatalogFromSource } from "../../lib/organizations/catalog/plan.js";
import { CATALOG_TYPE_MAP } from "../../lib/organizations/catalog/type-map.js";
import { alias, area, baseOrgs, homonymOrgs, makeCatalog, notAuto, org } from "../helpers/org-catalog-fixtures.js";

const codes = (plan: ReturnType<typeof buildCatalogPlan>) => plan.issues.map((i) => i.code);

describe("catálogo organizacional: estructura", () => {
  it("crea las organizaciones de la raíz hacia abajo, respetando la jerarquía y el mapeo de tipos", () => {
    const { plan } = planCatalogFromSource(makeCatalog({ orgs: [...baseOrgs()].reverse() })); // orden de entrada invertido
    expect(plan.counts.errores).toBe(0);
    const keys = plan.organizations.toCreate.map((o) => o.key);
    expect(keys.indexOf("MCGC")).toBeLessThan(keys.indexOf("SSPCGC"));
    expect(keys.indexOf("SSPCGC")).toBeLessThan(keys.indexOf("DGPAT"));
    expect(keys.indexOf("DGPAT")).toBeLessThan(keys.indexOf("pg:dgpat:archivo"));
    expect(plan.organizations.toCreate.find((o) => o.key === "pg:dgpat:archivo")).toMatchObject({ typeKey: "departamento", parentKey: "DGPAT", depth: 3 });
    expect(plan.counts.organizaciones_a_crear).toBe(5);
  });

  it("los tipos del catálogo tienen correspondencia y claves únicas", () => {
    const keys = Object.values(CATALOG_TYPE_MAP).map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const t of ["Ministerio", "Secretaría", "Subsecretaría", "Dirección General", "Dirección", "Departamento", "División", "Ente autárquico"]) expect(CATALOG_TYPE_MAP[t]).toBeTruthy();
  });

  it("padre inexistente: error y no se cargan ni el nodo ni sus descendientes", () => {
    const { plan } = planCatalogFromSource(makeCatalog({ orgs: [org("A", "A", "Ministerio"), org("B", "B", "Secretaría", "NOEXISTE"), org("C", "C", "Dirección General", "B")] }));
    expect(codes(plan)).toContain("MISSING_PARENT");
    expect(plan.organizations.toCreate.map((o) => o.key)).toEqual(["A"]);
    expect(plan.counts.errores).toBeGreaterThan(0);
  });

  it("ciclo, clave duplicada, código duplicado y tipo sin mapear: errores", () => {
    const cycle = planCatalogFromSource(makeCatalog({ orgs: [org("A", "A", "Ministerio", "B"), org("B", "B", "Secretaría", "A")] })).plan;
    expect(codes(cycle)).toContain("HIERARCHY_CYCLE");
    expect(cycle.organizations.toCreate).toHaveLength(0);
    expect(codes(planCatalogFromSource(makeCatalog({ orgs: [org("A", "A", "Ministerio"), org("A", "A2", "Ministerio")] })).plan)).toContain("DUPLICATE_KEY");
    expect(codes(planCatalogFromSource(makeCatalog({ orgs: [org("A", "A", "Ministerio", null, { codigo_oficial: "X" }), org("B", "B", "Ministerio", null, { codigo_oficial: "X" })] })).plan)).toContain("DUPLICATE_OFFICIAL_CODE");
    expect(codes(planCatalogFromSource(makeCatalog({ orgs: [org("A", "A", "Tipo Inventado")] })).plan)).toContain("UNMAPPED_TYPE");
  });

  it("no vigentes no se cargan", () => {
    const { plan } = planCatalogFromSource(makeCatalog({ orgs: [org("A", "A", "Ministerio"), org("B", "B", "Ministerio", null, { vigente: "No" })] }));
    expect(plan.organizations.toCreate.map((o) => o.key)).toEqual(["A"]);
    expect(codes(plan)).toContain("NOT_VIGENTE");
  });
});

describe("catálogo organizacional: alias", () => {
  const orgs = baseOrgs();

  it("solo AUTO_MAP=Sí se carga; PROBABLE / AMBIGUO / REVISAR / INVALIDO / histórico nunca", () => {
    const { plan } = planCatalogFromSource(
      makeCatalog({
        orgs,
        aliases: [alias("Cultura", "MCGC"), notAuto("TECBA", "PROBABLE", "MCGC"), notAuto("Min. cultura y algo", "AMBIGUO"), notAuto("sastreria -cultura", "REVISAR"), notAuto("0", "INVALIDO"), notAuto("area historica", "INTERNO_HISTORICO")],
      })
    );
    expect(plan.aliases.toCreate.map((a) => a.alias)).toEqual(["Cultura"]);
    expect(plan.aliases.notLoaded).toEqual({ PROBABLE: 1, AMBIGUO: 1, REVISAR: 1, INVALIDO: 1, INTERNO_HISTORICO: 1 });
    expect(plan.counts.aliases_no_cargados_por_no_ser_auto_map).toBe(5);
  });

  it("un alias por texto comparable: mayúsculas, tildes y puntuación se unifican sin perder filas", () => {
    const { plan } = planCatalogFromSource(makeCatalog({ orgs, aliases: [alias("Cultura", "MCGC"), alias("CULTURA", "MCGC"), alias("cultura?", "MCGC"), alias("Cultúra ", "MCGC")] }));
    expect(plan.aliases.toCreate).toHaveLength(1);
    expect(plan.aliases.toCreate[0]).toMatchObject({ alias: "Cultura", organizationKey: "MCGC", variants: 3, filasOrigen: 12 });
  });

  it("el mismo texto hacia destinos distintos es AMBIGUO: no se carga ninguno", () => {
    const { plan } = planCatalogFromSource(makeCatalog({ orgs, aliases: [alias("Patrimonio", "DGPAT"), alias("PATRIMONIO", "SSPCGC"), alias("Cultura", "MCGC")] }));
    expect(plan.aliases.ambiguous).toEqual([{ alias: "Patrimonio", targets: ["DGPAT", "SSPCGC"] }]);
    expect(plan.aliases.toCreate.map((a) => a.alias)).toEqual(["Cultura"]);
    expect(codes(plan)).toContain("ALIAS_AMBIGUOUS_IN_CATALOG");
  });

  it("alias con destino inexistente, vacío, o AUTO_MAP con un match_type no seguro: error, no se carga", () => {
    const { plan } = planCatalogFromSource(
      makeCatalog({ orgs, aliases: [alias("Fantasma", "NOEXISTE"), alias("   ", "MCGC"), alias("Dudoso", "MCGC", { match_type: "PROBABLE" }), alias("Bien", "MCGC")] })
    );
    expect(codes(plan)).toEqual(expect.arrayContaining(["ALIAS_TARGET_MISSING", "ALIAS_BLANK", "AUTO_MAP_WITH_NON_SAFE_MATCH"]));
    expect(plan.aliases.toCreate.map((a) => a.alias)).toEqual(["Bien"]);
  });

  it("un alias hacia una organización que no se va a cargar (padre inexistente) no se carga", () => {
    const { plan } = planCatalogFromSource(makeCatalog({ orgs: [org("A", "A", "Ministerio"), org("B", "B", "Secretaría", "NOEXISTE")], aliases: [alias("bb", "B"), alias("aa", "A")] }));
    expect(plan.aliases.toCreate.map((a) => a.alias)).toEqual(["aa"]);
    expect(codes(plan)).toContain("ALIAS_TARGET_NOT_VIGENTE");
  });

  it("claves: la de la base (trigger 0012) conserva puntuación; la de comparación con el padrón, no", () => {
    expect(aliasKeyForDb("  Dirección   GENERAL ")).toBe("direccion general");
    expect(aliasKeyForDb("Cultura?")).toBe("cultura?");
    expect(aliasKey("Cultura?")).toBe("cultura");
  });
});

describe("catálogo organizacional: contra el estado de la base", () => {
  const catalog = makeCatalog({ orgs: baseOrgs(), aliases: [alias("Cultura", "MCGC"), alias("Patrimonio", "DGPAT")] });
  const state = (over: Record<string, unknown> = {}) =>
    ({
      types: [{ key: "ministerio", name: "Ministerio", level: 1 }],
      organizations: [{ id: "id-mcgc", official_code: "MCGC", name: "MINISTERIO DE CULTURA", parent_id: null, parent_official_code: null, type_key: "ministerio", active: true }],
      aliases: [],
      ...over,
    }) as any;

  it("lo ya cargado (por official_code) figura como existente y no se vuelve a crear", () => {
    const plan = buildCatalogPlan(catalog, state());
    expect(plan.organizations.existing).toEqual(["MCGC"]);
    expect(plan.organizations.toCreate.map((o) => o.key)).not.toContain("MCGC");
    expect(plan.counts.errores).toBe(0);
    expect(plan.types.toCreate.map((t) => t.key)).not.toContain("ministerio");
  });

  it("existe con el mismo código pero distinto nombre, padre, tipo o inactiva: conflicto, no se modifica", () => {
    for (const patch of [{ name: "Otro nombre" }, { type_key: "secretaria" }, { parent_official_code: "X" }, { active: false }]) {
      const plan = buildCatalogPlan(catalog, state({ organizations: [{ ...state().organizations[0], ...patch }] }));
      expect(codes(plan)).toContain("ORG_CONFLICT_DB");
    }
  });

  it("una organización SIN official_code con el mismo nombre podría ser un duplicado: se frena", () => {
    const plan = buildCatalogPlan(catalog, state({ organizations: [{ id: "x", official_code: null, name: "ministerio de cultura", parent_id: null, type_key: "ministerio", active: true }] }));
    expect(codes(plan)).toContain("ORG_NAME_COLLISION_DB");
  });

  it("alias ya cargado hacia la misma organización: existente; hacia otra: conflicto (no se pisa)", () => {
    const same = buildCatalogPlan(catalog, state({ aliases: [{ alias: "CULTURA", normalized_alias: "cultura", organization_id: "id-mcgc", official_code: "MCGC", status: "approved" }] }));
    expect(same.aliases.existing).toBe(1);
    expect(same.aliases.toCreate.map((a) => a.alias)).toEqual(["Patrimonio"]);
    const other = buildCatalogPlan(catalog, state({ aliases: [{ alias: "Cultura", normalized_alias: "cultura", organization_id: "id-otra", official_code: "OTRA", status: "approved" }] }));
    expect(codes(other)).toContain("ALIAS_CONFLICT_DB");
    expect(other.aliases.toCreate.map((a) => a.alias)).toEqual(["Patrimonio"]);
    // Un alias pendiente/rechazado no bloquea ni cuenta como existente.
    const pending = buildCatalogPlan(catalog, state({ aliases: [{ alias: "Cultura", normalized_alias: "cultura", organization_id: "id-otra", official_code: "OTRA", status: "pending" }] }));
    expect(codes(pending)).not.toContain("ALIAS_CONFLICT_DB");
  });
});

describe("catálogo organizacional: áreas internas", () => {
  it("una unidad interna es organización SOLO si ya figura en Organismos_Oficiales con su jerarquía; el resto queda como dato de origen", () => {
    const { plan } = planCatalogFromSource(
      makeCatalog({
        orgs: baseOrgs(),
        aliases: [alias("Patrimonio", "DGPAT")],
        areas: [
          area("DGPAT", "ARCHIVO", "pg:dgpat:archivo", "Sí", "ALIAS_SEGURO"),
          area("DGPAT", "TAREAS VARIAS DE OFICINA", null, "No", "REVISAR"),
          area("DGPAT", "PROGRAMA HISTORICO", null, "No", "INTERNO_HISTORICO"),
          area("MCGC", "ARCHIVO", "EATC", "No", "REVISAR"),
        ],
      })
    );
    expect(plan.areaAliases.autoMapArea).toBe(1);
    expect(plan.areaAliases.catalogedAsOrganization).toEqual([
      { parent: "DGPAT", area: "ARCHIVO", candidate: "pg:dgpat:archivo", candidateIsChildOfParent: true },
      { parent: "MCGC", area: "ARCHIVO", candidate: "EATC", candidateIsChildOfParent: false },
    ]);
    expect(plan.areaAliases.preservedAsSourceData).toBe(2);
    // No se creó ninguna organización por las áreas: solo las 5 oficiales.
    expect(plan.organizations.toCreate).toHaveLength(5);
  });
});

describe("plan_hash del catálogo", () => {
  const catalog = makeCatalog({ orgs: baseOrgs(), aliases: [alias("Cultura", "MCGC")] });
  it("estable y sensible a cualquier cambio del archivo o de una fila", () => {
    const base = planCatalogFromSource(catalog).planHash;
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(planCatalogFromSource(catalog).planHash).toBe(base);
    expect(planCatalogFromSource({ ...catalog, sha256: "b".repeat(64) }).planHash).not.toBe(base);
    expect(planCatalogFromSource(makeCatalog({ orgs: baseOrgs(), aliases: [alias("Cultura", "MCGC"), alias("Cultura general", "MCGC")], sha: catalog.sha256 })).planHash).not.toBe(base);
    expect(planCatalogFromSource(makeCatalog({ orgs: [...baseOrgs(), org("X", "X", "Ministerio")], aliases: [alias("Cultura", "MCGC")], sha: catalog.sha256 })).planHash).not.toBe(base);
  });
});

describe("catálogo organizacional: alias contextuales (familias de homónimos)", () => {
  const key = (a: { alias: string; contextKey: string | null; organizationKey: string }) => `${a.alias}|${a.contextKey}|${a.organizationKey}`;

  it("detecta las familias desde la estructura oficial: mismo nombre genérico y padres distintos (DGTAL, UAI), sin excepciones por nombre", () => {
    const { plan } = planCatalogFromSource(makeCatalog({ orgs: homonymOrgs() }));
    expect(plan.counts.errores).toBe(0);
    expect(plan.families.map((f) => f.genericKey).sort()).toEqual(["direccion general tecnica administrativa y legal", "unidad de auditoria interna"]);
    const dgtal = plan.families.find((f) => f.genericKey.startsWith("direccion general"))!;
    expect(dgtal.members.map((m) => [m.key, m.parentKey])).toEqual([["DGTALMC", "MCGC"], ["DGTALMHF", "MHFGC"], ["DGTALPG", "PG"]]);
    expect(dgtal.vocabulary.map((v) => v.kind).sort()).toEqual(["abbreviation", "acronym", "generic_name"]);
    expect(dgtal.vocabulary.find((v) => v.kind === "acronym")!.display).toBe("DGTAL");
    const uai = plan.families.find((f) => f.genericKey === "unidad de auditoria interna")!;
    expect(uai.members.map((m) => [m.key, m.parentKey])).toEqual([["UAIMC", "MCGC"], ["UAIPG", "PG"]]);
    expect(uai.vocabulary.find((v) => v.kind === "acronym")!.display).toBe("UAI");
  });

  it("genera un alias contextual por (texto genérico, miembro) con el padre como contexto; Cultura/Hacienda/Procuración quedan separadas", () => {
    const { plan } = planCatalogFromSource(makeCatalog({ orgs: homonymOrgs() }));
    const contextual = plan.aliases.toCreate.filter((a) => a.contextKey);
    expect(contextual.map(key)).toEqual(expect.arrayContaining(["DGTAL|MCGC|DGTALMC", "DGTAL|MHFGC|DGTALMHF", "DGTAL|PG|DGTALPG", "UAI|MCGC|UAIMC", "UAI|PG|UAIPG"]));
    expect(contextual.every((a) => a.origin === "homonym_family")).toBe(true);
    expect(plan.counts.aliases_contextuales_a_crear).toBe(3 * 3 + 2 * 2); // DGTAL: 3 textos × 3 miembros; UAI: 2 textos × 2 miembros
    expect(plan.counts.aliases_globales_a_crear).toBe(0);
  });

  it("un alias del catálogo V2 con el texto genérico (antes global, contextual por archivo) pasa a contextual: NO se carga como global", () => {
    const { plan } = planCatalogFromSource(
      makeCatalog({
        orgs: homonymOrgs(),
        aliases: [alias("DG TECNICA ADMINISTRATIVA Y LEGAL", "DGTALPG", { filas_origen: "70" }), alias("UNIDAD DE AUDITORIA INTERNA", "UAIPG", { filas_origen: "6" }), alias("DGTALMHF", "DGTALMHF"), alias("Cultura", "MCGC")],
      })
    );
    expect(plan.aliases.toCreate.filter((a) => !a.contextKey).map((a) => a.alias).sort()).toEqual(["Cultura", "DGTALMHF"]); // el código específico y el ministerio siguen siendo globales
    const converted = plan.aliases.toCreate.find((a) => a.alias === "DG TECNICA ADMINISTRATIVA Y LEGAL" && a.organizationKey === "DGTALPG")!;
    expect(converted).toMatchObject({ contextKey: "PG", matchType: "ALIAS_SEGURO_CONTEXTUAL", filasOrigen: 70 });
    // Y el texto genérico existe también para las otras jurisdicciones (con el mismo texto original).
    expect(plan.aliases.toCreate.filter((a) => a.alias === "DG TECNICA ADMINISTRATIVA Y LEGAL").map((a) => a.contextKey).sort()).toEqual(["MCGC", "MHFGC", "PG"]);
    expect(plan.families.flatMap((f) => f.convertedCatalogRows).map((r) => r.text).sort()).toEqual(["DG TECNICA ADMINISTRATIVA Y LEGAL", "UNIDAD DE AUDITORIA INTERNA"]);
  });

  it("un texto genérico que el catálogo apunta a una organización de OTRA familia es un error, no se carga", () => {
    const { plan } = planCatalogFromSource(makeCatalog({ orgs: homonymOrgs(), aliases: [alias("DGTAL", "DGPAT")] }));
    expect(codes(plan)).toContain("ALIAS_HOMONYM_TARGET_MISMATCH");
  });

  it("homónimos con el mismo padre, o sin padre, no se pueden distinguir: error", () => {
    const sameParent = planCatalogFromSource(makeCatalog({ orgs: [org("A", "A", "Ministerio"), org("X1", "Dirección General Legal", "Dirección General", "A"), org("X2", "Dirección General Legal", "Dirección General", "A")] })).plan;
    expect(codes(sameParent)).toContain("HOMONYM_SAME_PARENT");
    const noParent = planCatalogFromSource(makeCatalog({ orgs: [org("R1", "Unidad Legal", "Unidad"), org("R2", "Unidad Legal", "Unidad")] })).plan;
    expect(codes(noParent)).toContain("HOMONYM_WITHOUT_PARENT");
    expect(sameParent.aliases.toCreate).toHaveLength(0);
  });

  it("contra la base: un alias GLOBAL ya aprobado con el texto genérico haría sombra a los contextuales (conflicto); uno contextual igual ya existe", () => {
    const catalog = makeCatalog({ orgs: homonymOrgs() });
    const base = { types: [], organizations: [], contextSupported: true } as any;
    const shadow = buildCatalogPlan(catalog, { ...base, aliases: [{ alias: "DGTAL", normalized_alias: "dgtal", organization_id: "x", official_code: "DGTALPG", context_official_code: null, status: "approved" }] });
    expect(codes(shadow)).toContain("ALIAS_CONFLICT_DB");
    const present = buildCatalogPlan(catalog, { ...base, aliases: [{ alias: "DGTAL", normalized_alias: "dgtal", organization_id: "x", official_code: "DGTALPG", context_official_code: "PG", status: "approved" }] });
    expect(present.aliases.existing).toBe(1);
    expect(present.aliases.toCreate.some((a) => a.alias === "DGTAL" && a.contextKey === "PG")).toBe(false);
  });

  it("un alias contextual ya cargado apuntando a OTRA organización en el mismo contexto es conflicto (no se pisa)", () => {
    const catalog = makeCatalog({ orgs: homonymOrgs() });
    const plan = buildCatalogPlan(catalog, { types: [], organizations: [], aliases: [{ alias: "DGTAL", normalized_alias: "dgtal", organization_id: "x", official_code: "DGTALMC", context_official_code: "PG", status: "approved" }] } as any);
    expect(codes(plan)).toContain("ALIAS_CONFLICT_DB");
  });
});


describe("catálogo organizacional: las familias se detectan solas, sin hardcodear DGTAL / DGTA / UAI", () => {
  it("una unidad nueva del catálogo oficial crea una familia nueva (y sus alias contextuales) sin tocar el código", () => {
    const orgs = [
      ...homonymOrgs(),
      org("MSEGC", "Ministerio de Seguridad", "Ministerio"),
      org("SSSISTMC", "Subsecretaría de Sistemas", "Subsecretaría", "MCGC"),
      org("SSSISTMH", "Subsecretaría de Sistemas", "Subsecretaría", "MHFGC"),
      org("SSSISTMSE", "Subsecretaría de Sistemas", "Subsecretaría", "MSEGC"),
      org("GOPMC", "Gerencia Operativa de Prensa MCGC", "Unidad", "MCGC"),
      org("GOPMH", "Gerencia Operativa de Prensa MHFGC", "Unidad", "MHFGC"),
    ];
    const { plan } = planCatalogFromSource(makeCatalog({ orgs }));
    expect(plan.counts.errores).toBe(0);
    const generic = plan.families.map((f) => f.genericKey).sort();
    expect(generic).toEqual(["direccion general tecnica administrativa y legal", "gerencia operativa de prensa", "subsecretaria de sistemas", "unidad de auditoria interna"]);
    const sist = plan.aliases.toCreate.filter((a) => a.organizationKey.startsWith("SSSISTM") && a.contextKey);
    expect(sist.map((a) => `${a.alias}|${a.contextKey}|${a.organizationKey}`)).toEqual(
      expect.arrayContaining(["Subsecretaría de Sistemas|MCGC|SSSISTMC", "Subsecretaría de Sistemas|MHFGC|SSSISTMH", "Subsecretaría de Sistemas|MSEGC|SSSISTMSE"]))
    // Un acrónimo de solo 2 letras («SS») es demasiado genérico: no se genera como texto de la familia.
    expect(sist.some((a) => a.alias === "SS")).toBe(false
    );
    expect(plan.aliases.toCreate.filter((a) => a.alias.toLowerCase().startsWith("gerencia operativa de prensa") && a.contextKey).map((a) => a.contextKey).sort()).toEqual(["MCGC", "MHFGC"]);
  });
});

describe("catálogo organizacional: aliases aprobados por decisión humana", () => {
  const orgs = [...baseOrgs(), org("MEPHUGC", "Ministerio de Espacio Público e Higiene Urbana", "Ministerio"), org("SGCBA", "Sindicatura General de la Ciudad de Buenos Aires", "Ente autárquico")];
  const add = (alias: string, targetKey: string) => ({ alias, targetKey, approvedBy: "SUTECBA", approvedOn: "2026-09-21", reason: "test" });

  it("entran como aliases GLOBALES aprobados con origen human_approved y cambian el plan_hash", () => {
    const catalog = makeCatalog({ orgs, aliases: [alias("Cultura", "MCGC")] });
    const base = planCatalogFromSource(catalog);
    const withAdditions = planCatalogFromSource(catalog, [add("Ministerio de Espacio Publico", "MEPHUGC"), add("Sindicatura General de la Ciudad", "SGCBA")]);
    expect(withAdditions.plan.counts.errores).toBe(0);
    const human = withAdditions.plan.aliases.toCreate.filter((a) => a.origin === "human_approved");
    expect(human.map((a) => `${a.alias}|${a.contextKey}|${a.organizationKey}`).sort()).toEqual(["Ministerio de Espacio Publico|null|MEPHUGC", "Sindicatura General de la Ciudad|null|SGCBA"]);
    expect(withAdditions.plan.counts.aliases_por_decision_humana_a_crear).toBe(2);
    expect(withAdditions.plan.counts.aliases_globales_a_crear).toBe(base.plan.counts.aliases_globales_a_crear! + 2);
    expect(withAdditions.planHash).not.toBe(base.planHash);
  });

  it("pasan por las mismas validaciones: destino inexistente, texto vacío o ambiguo con otro alias → error, no se carga", () => {
    const catalog = makeCatalog({ orgs, aliases: [alias("Cultura", "MCGC")] });
    expect(codes(planCatalogFromSource(catalog, [add("Fantasma", "NOEXISTE")]).plan)).toContain("ALIAS_TARGET_MISSING");
    expect(codes(planCatalogFromSource(catalog, [add("   ", "MEPHUGC")]).plan)).toContain("ALIAS_BLANK");
    const ambiguous = planCatalogFromSource(catalog, [add("Cultura", "MEPHUGC")]).plan; // el texto ya apunta a MCGC
    expect(codes(ambiguous)).toContain("ALIAS_AMBIGUOUS_IN_CATALOG");
    expect(ambiguous.aliases.toCreate.some((a) => a.alias === "Cultura")).toBe(false);
  });

  it("los pendientes que NO se aprobaron siguen sin cargarse", () => {
    const catalog = makeCatalog({ orgs, aliases: [notAuto("Seguridad", "REVISAR"), notAuto("TECBA", "PROBABLE", "MCGC")] });
    const { plan } = planCatalogFromSource(catalog, [add("Ministerio de Espacio Publico", "MEPHUGC")]);
    expect(plan.aliases.toCreate.map((a) => a.alias)).toEqual(["Ministerio de Espacio Publico"]);
  });

  it("un alias aprobado ya cargado en la base queda como existente (idempotente)", () => {
    const catalog = makeCatalog({ orgs, aliases: [] });
    const state = { types: [], organizations: [], aliases: [{ alias: "Sindicatura General de la Ciudad", normalized_alias: "sindicatura general de la ciudad", organization_id: "x", official_code: "SGCBA", context_official_code: null, status: "approved" }], contextSupported: true } as any;
    const plan = buildCatalogPlan(catalog, state, [add("Sindicatura General de la Ciudad", "SGCBA")]);
    expect(plan.aliases.existing).toBe(1);
    expect(plan.aliases.toCreate.some((a) => a.organizationKey === "SGCBA")).toBe(false);
  });
});
