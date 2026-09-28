/**
 * The user's approvals stored with a native activation (#1175, #1186). A remote hook that
 * reaches a destination or a model needs exactly one matching grant; nothing else may
 * carry one. Enabling the package with that grant is the only way to admit it.
 */
import { z } from "zod";
import {
  type EvaluatorHookGrant,
  type EvaluatorHookGrantRequirement,
  evaluatorHookContract,
  evaluatorHookGrantProblem,
  evaluatorHookGrantRequirement,
  evaluatorHookGrantSchema,
} from "./hook-evaluator.ts";
import {
  type HttpHookGrant,
  type HttpHookGrantRequirement,
  httpHookContract,
  httpHookGrantProblem,
  httpHookGrantRequirement,
  httpHookGrantSchema,
} from "./hook-http.ts";
import type { ContributionDeclaration } from "./manifest.ts";

/** HTTP first: existing HTTP grants parse, and so digest, exactly as they always did. */
export const hookGrantSchema = z.union([httpHookGrantSchema, evaluatorHookGrantSchema]);
export type HookGrant = HttpHookGrant | EvaluatorHookGrant;
export type HookGrantRequirement = HttpHookGrantRequirement | EvaluatorHookGrantRequirement;

export function isHttpHookGrant(grant: HookGrant): grant is HttpHookGrant {
  return "url" in grant;
}

/** What enabling this contribution requires the user to approve, or null for nothing. */
export function hookGrantRequirement(
  contribution: string,
  declaration: ContributionDeclaration,
): HookGrantRequirement | null {
  switch (declaration.hook?.handler.kind) {
    case "http-v1":
      return httpHookGrantRequirement(contribution, httpHookContract(declaration));
    case "prompt-evaluator-v1":
    case "agent-evaluator-v1":
      return evaluatorHookGrantRequirement(contribution, evaluatorHookContract(declaration));
    default:
      return null;
  }
}

/** The first reason the grants do not approve exactly these requirements, or null. */
export function hookGrantsProblem(
  requirements: readonly HookGrantRequirement[],
  grants: readonly HookGrant[],
): string | null {
  for (const requirement of requirements) {
    const grant = grants.find((value) => value.contribution === requirement.contribution);
    const problem =
      "url" in requirement
        ? httpHookGrantProblem(
            requirement,
            grant === undefined ? undefined : isHttpHookGrant(grant) ? grant : null,
          )
        : evaluatorHookGrantProblem(
            requirement,
            grant === undefined ? undefined : isHttpHookGrant(grant) ? null : grant,
          );
    if (problem !== null) return problem;
  }
  return grants.some(
    (grant) => !requirements.some((item) => item.contribution === grant.contribution),
  )
    ? "hook-grant-unexpected"
    : null;
}
