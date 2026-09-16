"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/guard";
import { can } from "@/lib/permissions/can";
import { addManager, addMember, AssociationMemberError, removeManager, removeMember } from "@/lib/associations/members";
import { searchAnyActivePeople, searchPeopleToAdd } from "@/lib/associations/queries";

export interface SimpleResult {
  ok: boolean;
  error?: string;
}

function toMessage(err: unknown, fallback: string): string {
  return err instanceof AssociationMemberError ? err.message : fallback;
}

export interface SearchResult {
  results: Array<{ id: string; firstName: string; lastName: string; dni?: string | null }>;
  error?: string;
}

export async function searchMemberCandidatesAction(
  associationId: string,
  _prev: SearchResult,
  formData: FormData
): Promise<SearchResult> {
  const actor = await requireUser();
  const term = String(formData.get("search") ?? "");
  if (term.trim().length < 2) {
    return { results: [], error: "Escribí al menos 2 caracteres para buscar." };
  }
  const results = await searchPeopleToAdd(associationId, term, can(actor, "people.view_sensitive"));
  return { results };
}

export async function addMemberAction(
  associationId: string,
  personId: string
): Promise<SimpleResult> {
  const actor = await requireUser();
  try {
    await addMember(actor, associationId, personId);
    revalidatePath(`/asociaciones/${associationId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo agregar el miembro.") };
  }
}

export async function removeMemberAction(
  associationId: string,
  membershipId: string
): Promise<SimpleResult> {
  const actor = await requireUser();
  try {
    await removeMember(actor, membershipId);
    revalidatePath(`/asociaciones/${associationId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo quitar el miembro.") };
  }
}

export async function searchManagerCandidatesAction(
  _associationId: string,
  _prev: SearchResult,
  formData: FormData
): Promise<SearchResult> {
  await requireUser();
  const term = String(formData.get("search") ?? "");
  if (term.trim().length < 2) {
    return { results: [], error: "Escribí al menos 2 caracteres para buscar." };
  }
  const results = await searchAnyActivePeople(term);
  return { results };
}

export async function addManagerPersonAction(associationId: string, personId: string): Promise<SimpleResult> {
  const actor = await requireUser();
  try {
    await addManager(actor, associationId, { personId });
    revalidatePath(`/asociaciones/${associationId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo agregar el responsable.") };
  }
}

export async function addManagerUserAction(associationId: string, userId: string): Promise<SimpleResult> {
  const actor = await requireUser();
  try {
    await addManager(actor, associationId, { userId });
    revalidatePath(`/asociaciones/${associationId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo agregar el responsable.") };
  }
}

export async function removeManagerAction(associationId: string, managerId: string): Promise<SimpleResult> {
  const actor = await requireUser();
  try {
    await removeManager(actor, managerId);
    revalidatePath(`/asociaciones/${associationId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err, "No se pudo quitar el responsable.") };
  }
}
