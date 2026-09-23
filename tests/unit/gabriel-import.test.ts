import { describe, expect, it } from "vitest";
import {
  cellToIsoDate,
  cuilChecksumValid,
  deriveDniFromCuil,
  fingerprintRow,
  normalizeCuilValue,
  normalizeDniValue,
  parseDateAndTimeRange,
  resolveIdentity,
  textsCompatible,
} from "../../lib/imports/gabriel/normalize.js";
import { detectF06Layout, normalizeSedeSlug, parseSource } from "../../lib/imports/gabriel/sources.js";
import { buildPlan } from "../../lib/imports/gabriel/plan.js";
import { computePlanHash, planFromSources } from "../../lib/imports/gabriel/plan-hash.js";
import { nameTokensCompatible, nameTokens, phoneKey } from "../../lib/imports/gabriel/normalize.js";
import {
  agendaFile,
  courseListFile,
  cuilFor,
  date,
  f06L1,
  f06L2,
  f06L3,
  f06L4,
  f07File,
  f09File,
  f10File,
  makeFile,
  pdfResponsesFile,
} from "../helpers/gabriel-fixtures.js";

describe("normalización de identidad", () => {
  it("DNI: 7 u 8 dígitos, con puntos o espacios; el resto no es un DNI", () => {
    expect(normalizeDniValue("12.345.678")).toBe("12345678");
    expect(normalizeDniValue("1234567")).toBe("1234567");
    expect(normalizeDniValue("123456")).toBeNull();
    expect(normalizeDniValue("123456789")).toBeNull();
    expect(normalizeDniValue("12a45678")).toBeNull();
    expect(normalizeDniValue(null)).toBeNull();
  });

  it("CUIL: 11 dígitos con dígito verificador; uno alterado es inválido", () => {
    const cuil = cuilFor("12345678");
    expect(cuilChecksumValid(cuil)).toBe(true);
    const tampered = `${cuil.slice(0, 10)}${(Number(cuil[10]) + 1) % 10}`;
    expect(cuilChecksumValid(tampered)).toBe(false);
    expect(normalizeCuilValue(`${cuil.slice(0, 2)}-${cuil.slice(2, 10)}-${cuil[10]}`)).toEqual({ digits: cuil, valid: true });
    expect(normalizeCuilValue("123")).toEqual({ digits: null, valid: false });
  });

  it("deriva el DNI del CUIL, incluida la variante de 7 dígitos con 0 de relleno", () => {
    expect(deriveDniFromCuil(cuilFor("12345678"))).toBe("12345678");
    expect(deriveDniFromCuil(cuilFor("7654321"))).toBe("7654321");
    expect(deriveDniFromCuil("123")).toBeNull();
  });

  it("resuelve la identidad: explícito, derivado, inválido y contradictorio", () => {
    const cuil = cuilFor("22333444");
    expect(resolveIdentity("22333444", null)).toMatchObject({ dni: "22333444", dniSource: "explicit" });
    expect(resolveIdentity(null, cuil)).toMatchObject({ dni: "22333444", dniSource: "derived_from_cuil", cuilValid: true });
    expect(resolveIdentity("123", null)).toMatchObject({ dni: null, invalidDni: true });
    expect(resolveIdentity(null, "20111111113")).toMatchObject({ dni: null, cuilValid: false });
    // DNI y CUIL de la misma fila que no coinciden: no se elige ninguno.
    expect(resolveIdentity("99999999", cuil)).toMatchObject({ dni: null, dniCuilMismatch: true });
    expect(resolveIdentity(null, null)).toMatchObject({ dni: null, dniSource: null });
  });

  it("la huella de fila es estable ante el orden de claves y cambia con hoja, fila o contenido", () => {
    const a = fingerprintRow("hash", "H1", 5, { c0: "x", c1: "y" });
    expect(fingerprintRow("hash", "H1", 5, { c1: "y", c0: "x" })).toBe(a);
    expect(fingerprintRow("hash", "H2", 5, { c0: "x", c1: "y" })).not.toBe(a);
    expect(fingerprintRow("hash", "H1", 6, { c0: "x", c1: "y" })).not.toBe(a);
    expect(fingerprintRow("hash", "H1", 5, { c0: "x", c1: "z" })).not.toBe(a);
    expect(fingerprintRow("otro", "H1", 5, { c0: "x", c1: "y" })).not.toBe(a);
  });

  it("interpreta fecha y franja horaria del listado de cursada", () => {
    expect(parseDateAndTimeRange("09/09/2026           10 a 13 hs")).toEqual({ date: "2026-09-09", start: "10:00", end: "13:00" });
    expect(parseDateAndTimeRange("09/09/2026")).toEqual({ date: "2026-09-09", start: null, end: null });
    expect(parseDateAndTimeRange(null)).toEqual({ date: null, start: null, end: null });
    expect(cellToIsoDate("1/10/2007")).toBe("2007-10-01");
    expect(cellToIsoDate("31/02/2026")).toBeNull();
  });

  it("dos textos son compatibles si son iguales o uno prefija al otro; nunca se fusiona por nombre", () => {
    expect(textsCompatible("GARCÍA", "Garcia Lopez")).toBe(true);
    expect(textsCompatible("Perez", "Gomez")).toBe(false);
    expect(textsCompatible("", "Gomez")).toBe(true);
  });
});

describe("layouts de F06 (detección por fila)", () => {
  const p = { last: "Prueba", first: "Uno", dni: "30000001", email: "uno@example.com" };

  it("reconoce L1, L2, L3 y L4 con la posición de nombres, email y DNI", () => {
    expect(detectF06Layout(f06L1(p))).toBe("L1");
    expect(detectF06Layout(f06L2(p))).toBe("L2");
    expect(detectF06Layout(f06L3(p))).toBe("L3");
    expect(detectF06Layout(f06L4(p))).toBe("L4");
  });

  it("una misma hoja (Cruz Malta) mezcla L1 y L4: el layout sale de cada fila, no de la hoja", () => {
    const file = makeFile("F06", "Padron Gral x Repart.xlsx", [
      { name: "Cruz Malta", rows: [f06L1({ ...p, dni: "30000001" }), f06L4({ ...p, dni: "30000002" }), f06L1({ ...p, dni: "30000003" })] },
    ]);
    const { records } = parseSource(file);
    expect(records.map((r) => r.layout)).toEqual(["L1", "L4", "L1"]);
    expect(records.map((r) => r.person.dniRaw)).toEqual(["30000001", "30000002", "30000003"]);
  });

  it("un DNI mal cargado no invalida el layout: la fila se reconoce y se informa el DNI inválido", () => {
    const bad = f06L1({ ...p, dni: "123456789" });
    expect(detectF06Layout(bad)).toBe("L1");
    const plan = buildPlan([makeFile("F06", "Padron Gral x Repart.xlsx", [{ name: "ASI", rows: [bad] }])]);
    expect(plan.rows[0]!.issues.map((i) => i.code)).toContain("INVALID_DNI_FORMAT");
    expect(plan.rows[0]!.status).toBe("in_review");
    expect(plan.people.toCreate).toHaveLength(0);
  });

  it("una fila que no encaja queda UNRECOGNIZED_LAYOUT, conserva el crudo y no crea nada", () => {
    const junk = ["Solo", "texto", null, null];
    expect(detectF06Layout(junk)).toBeNull();
    const plan = buildPlan([makeFile("F06", "Padron Gral x Repart.xlsx", [{ name: "ASI", rows: [junk] }])]);
    const row = plan.rows[0]!;
    expect(row.issues.map((i) => i.code)).toContain("UNRECOGNIZED_LAYOUT");
    expect(row.issues.map((i) => i.code)).not.toContain("MISSING_CANONICAL_DNI");
    expect(row.record.rawData).toMatchObject({ c0: "Solo", c1: "texto" });
    expect(plan.people.toCreate).toHaveLength(0);
    expect(plan.counts.filas_sin_dni_por_codigo).toEqual({ UNRECOGNIZED_LAYOUT: 1 });
  });

  it("la marca temporal del formulario NO se usa como fecha de atención: la inscripción va a la campaña, sin jornada", () => {
    const plan = buildPlan([makeFile("F06", "Padron Gral x Repart.xlsx", [{ name: "Teatro Colón", rows: [f06L3(p)] }])]);
    expect(plan.participations).toHaveLength(1);
    expect(plan.participations[0]!.target).toEqual({ type: "campaign", key: "ophthalmology:teatro-colon" });
    expect(plan.events.toCreate).toHaveLength(0);
  });
});

describe("eventos históricos", () => {
  it("F08: una jornada por fecha y sede; 'educacion 1' y 'educación 2' son UNA sola sede", () => {
    expect(normalizeSedeSlug("educacion 1")).toBe("educacion");
    expect(normalizeSedeSlug("educación 2")).toBe("educacion");
    expect(normalizeSedeSlug("Infraestructura esc")).toBe("infraestructura-escolar");
    expect(normalizeSedeSlug("canale")).toBe("canale");

    const { events } = parseSource(
      agendaFile([
        ["martes", "2026-04-01", "educacion 1"],
        ["martes", "2026-05-05", "educación 2"],
        ["miercoles", "2026-05-06", "educación 2"],
        ["jueves", "2026-05-07", "educación 2"],
        ["martes", "2026-03-10", "PROCURACIÓN"],
      ])
    );
    expect(events.map((e) => e.key).sort()).toEqual([
      "ophthalmology:2026-03-10:procuracion",
      "ophthalmology:2026-04-01:educacion",
      "ophthalmology:2026-05-05:educacion",
      "ophthalmology:2026-05-06:educacion",
      "ophthalmology:2026-05-07:educacion",
    ]);
    expect(events.every((e) => e.type === "operativo_salud" && e.subtype === "oftalmologia" && e.schedulePrecision === "date_only")).toBe(true);
    expect(events.every((e) => e.startTime === null && e.endTime === null)).toBe(true);
  });

  it("F08: la fila final sin fecha es MISSING_EVENT_DATE, se conserva y no crea evento", () => {
    const parsed = parseSource(agendaFile([["martes", "2026-03-10", "Procuración"], ["martes", null, null]]));
    expect(parsed.events).toHaveLength(1);
    const last = parsed.records[parsed.records.length - 1]!;
    expect(last.issues.map((i) => i.code)).toEqual(["MISSING_EVENT_DATE"]);
    expect(last.rawData).toMatchObject({ c0: "martes" });
  });

  it("F02 (RCP 52010): fecha y franja de la fuente; F05 sin fecha queda pendiente (no se inventa)", () => {
    const rcp = parseSource(courseListFile("F02", "52010-RCP CRUZ MALTA.xlsx", { code: "52010", when: "09/09/2026           10 a 13 hs" }, [{ cuil: cuilFor("30000001"), last: "A", first: "B" }]));
    expect(rcp.events).toEqual([
      expect.objectContaining({ key: "training:52010", name: "RCP Cruz Malta", type: "capacitacion", schedulePrecision: "exact_datetime", eventDate: "2026-09-09", startTime: "10:00", endTime: "13:00" }),
    ]);

    const emotional = parseSource(courseListFile("F05", "52469-INTELIGENCIA EMOCIONAL EN LA ORGANIZACION - A.G.C.xlsx", {}, [{ cuil: cuilFor("30000002"), last: "C", first: "D" }]));
    expect(emotional.events).toEqual([expect.objectContaining({ key: "training:52469", schedulePrecision: "unknown", eventDate: null, startTime: null })]);
  });

  it("F03 queda pendiente de clasificación: sin evento, sin participación y con incidencia", () => {
    const file = pdfResponsesFile("F03", "AGC-CAPACITACION 2026 (Respuestas).pdf", [{ cuil: cuilFor("30000003"), fullName: "PEREZ JUAN" }]);
    const plan = buildPlan([file]);
    expect(plan.events.toCreate).toHaveLength(0);
    expect(plan.participations).toHaveLength(0);
    expect(plan.pendingClassificationRows).toHaveLength(1);
    expect(plan.rows.flatMap((r) => r.issues).map((i) => i.code)).toContain("PENDING_CLASSIFICATION");
    // Pero la persona sí existe como identidad (CUIL válido → DNI derivado).
    expect(plan.people.toCreate).toHaveLength(1);
  });

  it("los PDF traen apellido y nombre juntos: se conservan sin separar", () => {
    const plan = buildPlan([pdfResponsesFile("F01", "R.C.P -Cruz Malta (Respuestas).pdf", [{ cuil: cuilFor("30000004"), fullName: "GOMEZ LUCIA MARIA" }])]);
    expect(plan.people.toCreate[0]).toMatchObject({ lastName: "GOMEZ LUCIA MARIA", firstName: "(sin separar)" });
  });
});

describe("planificación (dry-run)", () => {
  it("una persona por DNI aunque aparezca en varias fuentes; el DNI explícito prevalece como procedencia", () => {
    const dni = "31000001";
    const plan = buildPlan([
      f09File([{ last: "Gomez", first: "Ana", dni, email: "ana@example.com" }]),
      f07File([{ last: "Gomez", first: "Ana", cuil: cuilFor(dni) }]),
    ]);
    expect(plan.people.toCreate).toHaveLength(1);
    expect(plan.people.toCreate[0]).toMatchObject({ dni, dniSource: "explicit", cuilCuit: cuilFor(dni) });
    expect(plan.counts.dni_canonicos_unicos).toBe(1);
    expect(plan.counts.dni_en_mas_de_una_fila).toBe(1);
  });

  it("DNI derivado del CUIL se marca derived_from_cuil y conserva el CUIL aparte", () => {
    const cuil = cuilFor("31000002");
    const plan = buildPlan([f10File([{ last: "Diaz", first: "Bruno", cuil }])]);
    expect(plan.people.toCreate[0]).toMatchObject({ dni: "31000002", dniSource: "derived_from_cuil", cuilCuit: cuil });
  });

  it("sin DNI ni CUIL válido no se crea persona: MISSING_CANONICAL_DNI (referidos de F10 incluidos)", () => {
    const plan = buildPlan([f10File([{ last: "Diaz", first: "Bruno", cuil: cuilFor("31000003") }], [{ last: "Ref", first: "Uno", phone: "1155550000" }])]);
    expect(plan.people.toCreate).toHaveLength(1);
    const referido = plan.rows.find((r) => r.record.layout === "abogados-referidos")!;
    expect(referido.issues.map((i) => i.code)).toContain("MISSING_CANONICAL_DNI");
    expect(referido.status).toBe("in_review");
    const separator = plan.rows.find((r) => r.record.issues.some((i) => i.code === "SECTION_HEADER") && r.record.rawData.c0 === "REFERIDOS DE PRUEBA")!;
    expect(separator.record.kind).toBe("residual");
    expect(plan.counts.filas_de_personas).toBe(2);
  });

  it("F09: la fila residual no es una persona ni cuenta como inscripción", () => {
    const plan = buildPlan([f09File([{ last: "Lopez", first: "Eva", dni: "31000004", email: "eva@example.com" }], { residual: true })]);
    expect(plan.counts.filas_de_personas).toBe(1);
    expect(plan.participations).toHaveLength(1);
    expect(plan.rows.some((r) => r.issues.some((i) => i.code === "RESIDUAL_ROW"))).toBe(true);
  });

  it("dos CUIL válidos distintos para el mismo DNI: BLOCKED_IDENTITY_CONFLICT, no se crea ni fusiona", () => {
    const dni = "31000005";
    const plan = buildPlan([f07File([{ last: "Ruiz", first: "Carla", cuil: cuilFor(dni, "20") }, { last: "Ruiz", first: "Carla", cuil: cuilFor(dni, "27") }])]);
    expect(plan.people.toCreate).toHaveLength(0);
    expect(plan.people.blocked).toHaveLength(1);
    expect(plan.conflicts.some((c) => c.code === "BLOCKED_IDENTITY_CONFLICT" && c.blocking && c.field === "cuil_cuit")).toBe(true);
    expect(plan.rows.every((r) => r.status !== "normalized")).toBe(true);
  });

  it("un CUIL con dígito verificador inválido no deriva DNI (INVALID_CUIL_CHECKSUM) y la fila queda en revisión", () => {
    const valid = cuilFor("31000006");
    const invalid = `${valid.slice(0, 10)}${(Number(valid[10]) + 1) % 10}`;
    const plan = buildPlan([f07File([{ last: "Sosa", first: "Dana", cuil: invalid }])]);
    expect(plan.rows[1]!.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["INVALID_CUIL_CHECKSUM", "MISSING_CANONICAL_DNI"]));
    expect(plan.people.toCreate).toHaveLength(0);
  });

  it("nombres materialmente distintos para un mismo DNI: BLOCKED_IDENTITY_CONFLICT, sin persona ni participaciones", () => {
    const dni = "31000007";
    const plan = buildPlan([
      f09File([{ last: "Vega", first: "Elena", dni, email: "elena@example.com" }]),
      f07File([{ last: "Otro", first: "Nombre", cuil: cuilFor(dni) }]),
    ]);
    expect(plan.people.toCreate).toHaveLength(0);
    expect(plan.people.blocked).toEqual([{ personKey: "P00001", reason: "name" }]);
    expect(plan.conflicts.filter((c) => c.blocking).map((c) => c.field)).toEqual(["name"]);
    expect(plan.participations).toHaveLength(0);
    expect(plan.rows.flatMap((r) => r.issues).some((i) => i.code === "BLOCKED_IDENTITY_CONFLICT")).toBe(true);
    expect(plan.counts.personas_bloqueadas_por_conflicto_de_identidad).toBe(1);
  });

  it("diferencias solo de formato en el nombre (mayúsculas, tildes, puntuación, segundo nombre, orden) NO son conflicto", () => {
    const dni = "31000010";
    const plan = buildPlan([
      f09File([{ last: "GARCÍA", first: "María José", dni, email: "mj@example.com" }]),
      f07File([{ last: "Garcia", first: "Maria", cuil: cuilFor(dni), organism: "Cultura" }]),
      f10File([{ last: "garcía.", first: "  josé maría ", cuil: cuilFor(dni) }]),
    ]);
    expect(plan.conflicts).toHaveLength(0);
    expect(plan.people.blocked).toHaveLength(0);
    expect(plan.people.toCreate).toHaveLength(1);
    // Se guarda el nombre más completo entre los compatibles.
    expect(plan.people.toCreate[0]).toMatchObject({ lastName: "GARCÍA", firstName: "María José" });
  });

  it("email distinto en el mismo DNI: conflicto NO bloqueante, el campo queda vacío y la persona se crea; mismo email con otro formato no es conflicto", () => {
    const dni = "31000011";
    const plan = buildPlan([
      f09File([{ last: "Vega", first: "Elena", dni, email: "Elena@Example.com" }]),
      f07File([{ last: "Vega", first: "Elena", cuil: cuilFor(dni), organism: "Cultura", email: "elena@example.com " }]),
      f07File([{ last: "Vega", first: "Elena", cuil: cuilFor(dni), organism: "Cultura", email: "otra@example.com" }]),
    ]);
    const person = plan.people.toCreate[0]!;
    expect(person.email).toBeNull();
    expect(person.pendingFields).toContain("email");
    expect(person.hasNonBlockingConflicts).toBe(true);
    expect(plan.conflicts.filter((c) => c.field === "email")).toEqual([expect.objectContaining({ blocking: false, code: "FIELD_CONFLICT" })]);

    const same = buildPlan([
      f09File([{ last: "Vega", first: "Elena", dni, email: "Elena@Example.com" }]),
      f07File([{ last: "Vega", first: "Elena", cuil: cuilFor(dni), organism: "Cultura", email: "elena@example.com " }]),
    ]);
    expect(same.conflicts).toHaveLength(0);
    expect(same.people.toCreate[0]!.email).toBe("elena@example.com");
  });

  it("campo vacío + un único valor consistente lo completa (una fuente sin email, otra con email)", () => {
    const dni = "31000012";
    const plan = buildPlan([f10File([{ last: "Sosa", first: "Luz", cuil: cuilFor(dni) }]), f07File([{ last: "Sosa", first: "Luz", cuil: cuilFor(dni), organism: "Cultura", email: "luz@example.com" }])]);
    expect(plan.conflicts).toHaveLength(0);
    expect(plan.people.toCreate[0]).toMatchObject({ email: "luz@example.com", hasNonBlockingConflicts: false });
  });

  it("teléfonos con distinto formato del mismo número no son conflicto; números distintos dejan el campo vacío", () => {
    const dni = "31000013";
    const same = buildPlan([
      f09File([{ last: "Paz", first: "Ana", dni, email: "a@example.com", phone: "1155551111" }]),
      f07File([{ last: "Paz", first: "Ana", cuil: cuilFor(dni), organism: "Cultura", phone: "011 5555-1111" }]),
    ]);
    expect(same.conflicts.filter((c) => c.field === "phone")).toHaveLength(0);
    const diff = buildPlan([
      f09File([{ last: "Paz", first: "Ana", dni, email: "a@example.com", phone: "1155551111" }]),
      f07File([{ last: "Paz", first: "Ana", cuil: cuilFor(dni), organism: "Cultura", phone: "1166662222" }]),
    ]);
    expect(diff.people.toCreate[0]!.phone).toBeNull();
    expect(diff.conflicts.filter((c) => c.field === "phone")).toHaveLength(1);
  });

  it("nacimiento y organismo contradictorios quedan sin completar (no se elige uno)", () => {
    const dni = "31000014";
    const plan = buildPlan([
      f09File([{ last: "Paz", first: "Ana", dni, email: "a@example.com", birth: "1980-01-01", organism: "Educación" }]),
      f09File([{ last: "Paz", first: "Ana", dni, email: "a@example.com", birth: "1981-02-02", organism: "Salud" }]),
    ]);
    const person = plan.people.toCreate[0]!;
    expect(person.birthDate).toBeNull();
    expect(person.organismText).toBeNull();
    expect(person.pendingFields).toEqual(["birth_date", "organism"]);
    expect(person.organizationId).toBeNull();
  });

  it("organismo: se mapea SOLO con correspondencia inequívoca; si no, organization_id NULL + incidencia; nunca se crean organismos", () => {
    const dni = "31000015";
    const files = [f09File([{ last: "Paz", first: "Ana", dni, email: "a@example.com", organism: "Ministerio de Educación" }])];

    const none = buildPlan(files);
    expect(none.people.toCreate[0]!.organizationId).toBeNull();
    expect(none.rows.flatMap((r) => r.issues).map((i) => i.code)).toContain("ORGANISM_UNMAPPED");

    const mapped = buildPlan(files, { organizationAliases: [{ alias: "MINISTERIO DE EDUCACION", organizationId: "org-1" }, { alias: "Ministerio de Salud", organizationId: "org-2" }] });
    expect(mapped.people.toCreate[0]!.organizationId).toBe("org-1");
    expect(mapped.counts.personas_con_organizacion_mapeada).toBe(1);

    // Dos aliases del mismo texto hacia unidades distintas: ambiguo, no se elige.
    const ambiguous = buildPlan(files, { organizationAliases: [{ alias: "Ministerio de Educación", organizationId: "org-1" }, { alias: "ministerio de educacion", organizationId: "org-9" }] });
    expect(ambiguous.people.toCreate[0]!.organizationId).toBeNull();
    expect(ambiguous.rows.flatMap((r) => r.issues).map((i) => i.code)).toContain("ORGANISM_AMBIGUOUS");

    // Varios aliases hacia la MISMA unidad no son ambiguos.
    const same = buildPlan(files, { organizationAliases: [{ alias: "Ministerio de Educación", organizationId: "org-1" }, { alias: "MIN. EDUCACION", organizationId: "org-1" }, { alias: "ministerio de educacion", organizationId: "org-1" }] });
    expect(same.people.toCreate[0]!.organizationId).toBe("org-1");

    // Una unidad parecida o cuyo NOMBRE coincide, pero sin alias aprobado, NO se acepta por aproximación.
    const near = buildPlan(files, { organizationAliases: [{ alias: "Educación", organizationId: "org-3" }] });
    expect(near.people.toCreate[0]!.organizationId).toBeNull();
  });

  it("textos distintos que resuelven a la MISMA unidad no son conflicto de organismo; si uno no resuelve, sí", () => {
    const dni = "31000016";
    const aliases = [{ alias: "Cultura", organizationId: "org-c" }, { alias: "Ministerio de Cultura", organizationId: "org-c" }];
    const same = buildPlan(
      [f09File([{ last: "Paz", first: "Ana", dni, email: "a@example.com", organism: "Cultura" }]), f07File([{ last: "Paz", first: "Ana", cuil: cuilFor(dni), organism: "MINISTERIO DE CULTURA" }])],
      { organizationAliases: aliases }
    );
    expect(same.conflicts.filter((c) => c.field === "organism")).toHaveLength(0);
    expect(same.people.toCreate[0]!.organizationId).toBe("org-c");
    const mixed = buildPlan(
      [f09File([{ last: "Paz", first: "Ana", dni, email: "a@example.com", organism: "Cultura" }]), f07File([{ last: "Paz", first: "Ana", cuil: cuilFor(dni), organism: "sastreria -cultura" }])],
      { organizationAliases: aliases }
    );
    expect(mixed.conflicts.filter((c) => c.field === "organism")).toHaveLength(1);
    expect(mixed.people.toCreate[0]!.organizationId).toBeNull();
  });

  it("clasifica las personas: listas, con conflictos no bloqueantes y bloqueadas", () => {
    const plan = buildPlan([
      f09File([
        { last: "Uno", first: "Ana", dni: "32100001", email: "a@example.com" },
        { last: "Dos", first: "Bea", dni: "32100002", email: "b@example.com" },
        { last: "Tres", first: "Cai", dni: "32100003", email: "c@example.com" },
      ]),
      f07File([
        { last: "Dos", first: "Bea", cuil: cuilFor("32100002"), organism: "Cultura", email: "otro@example.com" },
        { last: "Distinto", first: "Nombre", cuil: cuilFor("32100003"), organism: "Cultura" },
      ]),
    ]);
    expect(plan.counts).toMatchObject({
      personas_a_crear: 2,
      personas_listas_para_crear: 1,
      personas_con_conflictos_no_bloqueantes: 1,
      personas_bloqueadas_por_conflicto_de_identidad: 1,
      conflictos_bloqueantes: 1,
      conflictos_no_bloqueantes: 1,
    });
  });

  it("personas existentes: se completan vacíos inequívocos, no se pisa nada y una identidad distinta bloquea", () => {
    const dni = "31000008";
    const files = [f09File([{ last: "Paz", first: "Franco", dni, email: "franco@example.com" }])];
    const empty = buildPlan(files, { existingPeople: new Map([[dni, { firstName: "Franco", lastName: "Paz", email: null, phone: null, cuilCuit: null }]]) });
    expect(empty.people.toCreate).toHaveLength(0);
    expect(empty.people.toUpdate).toEqual([{ dni, fills: ["email", "phone"], values: { email: "franco@example.com", phone: expect.any(String) } }]);

    const clash = buildPlan(files, { existingPeople: new Map([[dni, { firstName: "Franco", lastName: "Paz", email: "distinto@example.com", phone: "+5491155551111", cuilCuit: null }]]) });
    expect(clash.people.toUpdate.find((u) => u.dni === dni)?.fills ?? []).not.toContain("email");
    expect(clash.conflicts.some((c) => c.field === "existing_record" && !c.blocking)).toBe(true);

    const other = buildPlan(files, { existingPeople: new Map([[dni, { firstName: "Otra", lastName: "Persona", email: null, phone: null, cuilCuit: null }]]) });
    expect(other.people.blocked).toHaveLength(1);
    expect(other.people.toUpdate).toHaveLength(0);
    expect(other.participations).toHaveLength(0);
  });

  it("inscripciones: una por (destino, persona, tipo) aunque haya varias filas; nunca hay asistencia", () => {
    const dni = "31000009";
    const cuil = cuilFor(dni);
    const plan = buildPlan([
      courseListFile("F02", "52010-RCP CRUZ MALTA.xlsx", { code: "52010", when: "09/09/2026 10 a 13 hs" }, [{ cuil, last: "Gil", first: "Hugo" }]),
      pdfResponsesFile("F01", "R.C.P -Cruz Malta (Respuestas).pdf", [{ cuil, fullName: "GIL HUGO" }]),
    ]);
    expect(plan.participations).toHaveLength(1);
    expect(plan.participations[0]).toMatchObject({ target: { type: "event", key: "training:52010" }, kind: "registration" });
    expect(plan.participations[0]!.rows).toHaveLength(2);
    expect(plan.counts.asistencias_acreditadas).toBe(0);
    expect(plan.participations.every((p) => p.kind !== "attended")).toBe(true);
    // F01 y F02 comparten el evento: se fusionan en uno solo, con la fecha conocida de F02.
    expect(plan.events.toCreate).toEqual([expect.objectContaining({ key: "training:52010", schedulePrecision: "exact_datetime", sourceFiles: ["F01", "F02"] })]);
  });

  it("informe de conteos coherente con el plan", () => {
    const plan = buildPlan([
      f09File([{ last: "A", first: "A", dni: "32000001", email: "a@example.com" }, { last: "B", first: "B", dni: "32000002", email: "b@example.com" }]),
      f10File([{ last: "C", first: "C", cuil: cuilFor("32000003") }], [{ last: "R", first: "R" }]),
      agendaFile([["martes", "2026-03-10", "Procuración"], ["martes", null, null]]),
    ]);
    expect(plan.counts).toMatchObject({
      filas_de_personas: 4,
      con_dni_canonico: 3,
      dni_explicito: 2,
      dni_derivado_de_cuil: 1,
      filas_sin_dni: 1,
      personas_a_crear: 3,
      reuniones_a_crear: 1,
      inscripciones_a_campana_sin_jornada: 2,
      asistencias_acreditadas: 0,
    });
    expect(plan.counts.incidencias_por_codigo).toMatchObject({ MISSING_CANONICAL_DNI: 1, MISSING_EVENT_DATE: 1 });
  });

  it("es determinista: el mismo insumo da exactamente el mismo plan", () => {
    const build = () =>
      buildPlan([
        f09File([{ last: "A", first: "A", dni: "32000001", email: "a@example.com" }]),
        f07File([{ last: "A", first: "A", cuil: cuilFor("32000001") }]),
      ]);
    expect(JSON.stringify(build().counts)).toBe(JSON.stringify(build().counts));
    expect(build().people.toCreate).toEqual(build().people.toCreate);
  });

  it("los informes no necesitan datos personales: las referencias de conflicto son solo archivo/hoja/fila", () => {
    const plan = buildPlan([
      f09File([{ last: "Vega", first: "Elena", dni: "33000001", email: "elena@example.com" }]),
      f07File([{ last: "Otro", first: "Nombre", cuil: cuilFor("33000001") }]),
    ]);
    const serialized = JSON.stringify(plan.conflicts);
    expect(serialized).not.toContain("33000001");
    expect(serialized).not.toContain("Vega");
    expect(serialized).not.toContain("elena@example.com");
    void date;
  });
});

describe("plan_hash", () => {
  const sources = () => [
    f09File([{ last: "A", first: "A", dni: "33100001", email: "a@example.com" }]),
    f10File([{ last: "B", first: "B", cuil: cuilFor("33100002") }]),
    agendaFile([["martes", "2026-03-10", "Procuración"]]),
  ];

  it("es un SHA-256 estable: mismos archivos → mismo hash, sin importar el orden de carga", () => {
    const files = sources();
    const a = planFromSources(files).planHash;
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(planFromSources(files).planHash).toBe(a);
    expect(planFromSources([...files].reverse()).planHash).toBe(a);
  });

  it("cambia si cambia un archivo (su SHA-256), una fila, o el conjunto de archivos", () => {
    const files = sources();
    const base = planFromSources(files).planHash;
    expect(planFromSources(files.map((f, i) => (i === 0 ? { ...f, sha256: "a".repeat(64) } : f))).planHash).not.toBe(base);
    expect(planFromSources([f09File([{ last: "A", first: "A", dni: "33100009", email: "a@example.com" }]), files[1]!, files[2]!]).planHash).not.toBe(base);
    expect(planFromSources(files.slice(0, 2)).planHash).not.toBe(base);
  });

  it("no depende del estado de la base: el plan con personas existentes tiene otro contenido pero el hash se calcula siempre sin ellas", () => {
    const files = sources();
    const withExisting = buildPlan(files, { existingPeople: new Map([["33100001", { firstName: "A", lastName: "A", email: null, phone: null, cuilCuit: null }]]) });
    expect(computePlanHash(withExisting)).not.toBe(planFromSources(files).planHash);
    expect(planFromSources(files).planHash).toBe(planFromSources(files).planHash);
  });
});

describe("normalizadores de comparación", () => {
  it("nameTokensCompatible: subconjunto de palabras sí; palabras propias en ambos lados no", () => {
    expect(nameTokensCompatible(nameTokens("Garcia Maria"), nameTokens("MARÍA JOSÉ GARCÍA"))).toBe(true);
    expect(nameTokensCompatible(nameTokens("Garcia Maria"), nameTokens("Garcia Marta"))).toBe(false);
    expect(nameTokensCompatible([], nameTokens("Garcia"))).toBe(true);
  });

  it("phoneKey unifica prefijos país/0 troncal", () => {
    expect(new Set(["+5491155551111", "011 5555-1111", "1155551111", "54 9 11 5555 1111"].map(phoneKey))).toEqual(new Set(["1155551111"]));
  });
});

describe("conteos de personas sin ambigüedad", () => {
  it("identidades canónicas = INSERT reales + bloqueadas; las filas sin DNI no son identidades", () => {
    const plan = buildPlan([
      f09File([
        { last: "Uno", first: "Ana", dni: "34000001", email: "a@example.com" },
        { last: "Dos", first: "Bea", dni: "34000002", email: "b@example.com" },
        { last: "Tres", first: "Cai", dni: "34000003", email: "c@example.com" },
      ]),
      f07File([
        { last: "Distinto", first: "Nombre", cuil: cuilFor("34000003") }, // bloquea a 34000003
        { last: "Sin", first: "Documento", cuil: "20999999995" }, // CUIL inválido: fila sin DNI
      ]),
    ]);
    expect(plan.counts.identidades_canonicas_totales).toBe(3);
    expect(plan.counts.people_insert_reales).toBe(2);
    expect(plan.people.blocked).toHaveLength(1);
    expect(plan.counts.identidades_canonicas_totales).toBe(plan.counts.people_insert_reales + plan.people.blocked.length);
    expect(plan.counts.filas_de_identidades_bloqueadas).toBe(2); // las dos apariciones del DNI bloqueado
    expect(plan.counts.filas_sin_dni).toBe(1);
  });
});
