import { describe, expect, it } from "vitest";
import {
  canEditCoreFields,
  canManageInvitations,
  canTransition,
  isOverdueUnclosed,
  isPubliclyRespondable,
} from "../../lib/meetings/state-machine.js";

describe("máquina de estados de reuniones (sección 11 del prompt)", () => {
  it("permite draft->scheduled->in_progress->finished", () => {
    expect(canTransition("draft", "scheduled")).toBe(true);
    expect(canTransition("scheduled", "in_progress")).toBe(true);
    expect(canTransition("in_progress", "finished")).toBe(true);
  });

  it("permite cancelar desde borrador, programada o en curso", () => {
    expect(canTransition("draft", "cancelled")).toBe(true);
    expect(canTransition("scheduled", "cancelled")).toBe(true);
    expect(canTransition("in_progress", "cancelled")).toBe(true);
  });

  it("no permite saltear estados ni revivir una finalizada/cancelada", () => {
    expect(canTransition("draft", "finished")).toBe(false);
    expect(canTransition("draft", "in_progress")).toBe(false);
    expect(canTransition("finished", "scheduled")).toBe(false);
    expect(canTransition("cancelled", "scheduled")).toBe(false);
  });

  it("los datos centrales solo se editan en borrador o programada", () => {
    expect(canEditCoreFields("draft")).toBe(true);
    expect(canEditCoreFields("scheduled")).toBe(true);
    expect(canEditCoreFields("in_progress")).toBe(false);
    expect(canEditCoreFields("finished")).toBe(false);
  });

  it("las invitaciones se manejan desde programada hasta que termina", () => {
    expect(canManageInvitations("draft")).toBe(false);
    expect(canManageInvitations("scheduled")).toBe(true);
    expect(canManageInvitations("in_progress")).toBe(true);
    expect(canManageInvitations("finished")).toBe(false);
  });

  it("el público solo puede responder mientras está programada", () => {
    expect(isPubliclyRespondable("scheduled")).toBe(true);
    expect(isPubliclyRespondable("in_progress")).toBe(false);
    expect(isPubliclyRespondable("draft")).toBe(false);
  });

  it("una reunión programada con fecha de fin pasada se marca vencida sin cerrar sola", () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);
    expect(isOverdueUnclosed("scheduled", past)).toBe(true);
    expect(isOverdueUnclosed("scheduled", future)).toBe(false);
    expect(isOverdueUnclosed("finished", past)).toBe(false);
    expect(isOverdueUnclosed("cancelled", past)).toBe(false);
  });
});
