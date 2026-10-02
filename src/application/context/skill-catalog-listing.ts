/**
 * One page of the session's skill catalog as human lines (#1179, #948).
 *
 * The shell, a headless run and the model route all list skills through this
 * read, so each caller sees the same catalog for the same owner. The catalog is
 * refreshed first, so a newly added skill is listed. No skill body is read.
 */
import { randomUUID } from "node:crypto";

import type { InstructionScope } from "../../domain/context/instruction-sources.ts";
import { skillCatalogLines } from "../../domain/context/skill-invocation.ts";
import type { InstructionSourceOwner } from "./instruction-source-owner.ts";

export type SkillCatalogPageRequest = {
  readonly filter: string | null;
  readonly offset: number;
};

/** Refresh the owner's skill publication; a failed refresh keeps the last one. */
export function refreshSkillCatalog(
  owner: Pick<InstructionSourceOwner, "prepare">,
  scope: Omit<InstructionScope, "execution">,
  signal: AbortSignal,
): Promise<unknown> {
  return owner
    .prepare({ ...scope, execution: `skill-catalog:${randomUUID()}` }, [], signal, undefined, true)
    .catch(() => undefined);
}

export async function skillCatalogPageLines(
  owner: Pick<InstructionSourceOwner, "prepare" | "skillCatalog">,
  scope: Omit<InstructionScope, "execution">,
  page: SkillCatalogPageRequest,
  signal: AbortSignal,
): Promise<readonly string[]> {
  await refreshSkillCatalog(owner, scope, signal);
  return skillCatalogLines(
    owner.skillCatalog({ ...scope, execution: "skill-catalog" }, page),
    page.filter,
  );
}
