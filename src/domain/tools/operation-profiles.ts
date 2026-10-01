/**
 * Operation profiles (#946).
 *
 * A profile is one model-facing definition that groups a few related native
 * operations, such as Git inspection. It owns nothing at run time: before
 * binding, a call to a profile is lowered to the exact native tool call it
 * names, so validation, effects, conflict keys, admission, events and results
 * are the native operation's own. Profile identity (name, id, version) and
 * native identity (tool name, capability id, version) stay separate.
 *
 * The model-facing arguments are `{ "operation": "<op>", "<op>": { ...native
 * arguments } }`. Each operation's arguments live under a property of the same
 * name rather than in a union, so every provider's strict-schema dialect can
 * encode them without an ambiguous branch.
 */

import type { ProfileOperationRefusal, ToolBindError } from "./tool-pipeline.ts";

export const OPERATION_PROFILE_SCHEMA_VERSION = 1 as const;

/** Profiles are emitted only when this many of their operations are disclosed. */
export const MIN_PROFILE_OPERATIONS = 2;

export type OperationProfileMember = {
  /** Lowercase word the model sends as `operation`. */
  readonly operation: string;
  /** Exact native tool the operation lowers to. */
  readonly toolName: string;
};

export type OperationProfileDefinition = {
  /** Stable profile identity, such as `git.inspect`. */
  readonly id: string;
  readonly version: number;
  /** Model-facing tool name, such as `git_inspect`. */
  readonly name: string;
  readonly description: string;
  readonly members: readonly OperationProfileMember[];
};

/** A profile as disclosed to one attempt: only operations whose native tools are disclosed. */
export type DisclosedOperationProfile = {
  readonly name: string;
  readonly profileId: string;
  readonly version: number;
  readonly operations: readonly OperationProfileMember[];
};

/** One provider-facing definition, in disclosure order. */
export type ProfileProjectionItem =
  | { readonly kind: "native"; readonly name: string }
  | {
      readonly kind: "profile";
      readonly definition: OperationProfileDefinition;
      readonly operations: readonly OperationProfileMember[];
      /** Members of the definition that are not disclosed to this attempt. */
      readonly omitted: readonly OperationProfileMember[];
    };

/**
 * Which provider definitions an ordered set of disclosed native tools becomes.
 *
 * A profile with at least {@link MIN_PROFILE_OPERATIONS} disclosed members
 * replaces them and takes the place of its first member; members are listed in
 * the profile's declared order. Every other tool stays a native definition.
 * Pure and deterministic, so disclosure and attempt validation agree.
 */
export function planProfileProjection(
  definitions: readonly OperationProfileDefinition[],
  disclosedNames: readonly string[],
): readonly ProfileProjectionItem[] {
  const disclosed = new Set(disclosedNames);
  const grouped = new Map<string, OperationProfileDefinition>();
  for (const definition of definitions) {
    const present = definition.members.filter((member) => disclosed.has(member.toolName));
    if (present.length < MIN_PROFILE_OPERATIONS) continue;
    for (const member of present) grouped.set(member.toolName, definition);
  }
  const items: ProfileProjectionItem[] = [];
  const emitted = new Set<string>();
  for (const name of disclosedNames) {
    const definition = grouped.get(name);
    if (definition === undefined) {
      items.push({ kind: "native", name });
      continue;
    }
    if (emitted.has(definition.id)) continue;
    emitted.add(definition.id);
    items.push({
      kind: "profile",
      definition,
      operations: definition.members.filter((member) => disclosed.has(member.toolName)),
      omitted: definition.members.filter((member) => !disclosed.has(member.toolName)),
    });
  }
  return items;
}

/**
 * How the model can call a native tool this attempt: `git_inspect(status)` for a
 * profile member, the tool's own name otherwise. For text shown to the model,
 * such as fallback candidates, which must name something it can call.
 */
export function callableName(
  profiles: readonly DisclosedOperationProfile[],
  toolName: string,
): string {
  for (const profile of profiles) {
    const member = profile.operations.find((operation) => operation.toolName === toolName);
    if (member !== undefined) return `${profile.name}(${member.operation})`;
  }
  return toolName;
}

/** The native tool call a profile call names. */
export type ProfileProposal = {
  readonly toolCallId: string;
  readonly name: string;
  readonly arguments: unknown;
};

export type LoweredProposals<T extends ProfileProposal> =
  | { readonly ok: true; readonly value: readonly T[] }
  | {
      readonly ok: false;
      readonly error: Extract<ToolBindError, { code: "profile-operation-invalid" }>;
    };

/**
 * Lower each profile call to its native tool call; other proposals pass through
 * unchanged. The tool call id is kept, so results still pair with the call the
 * model made. One invalid profile call refuses the batch, as any binding error does.
 */
export function lowerProfileProposals<T extends ProfileProposal>(
  profiles: readonly DisclosedOperationProfile[],
  proposals: readonly T[],
  definitions: readonly OperationProfileDefinition[] = [],
): LoweredProposals<T> {
  const byName = new Map(profiles.map((profile) => [profile.name, profile]));
  const lowered: T[] = [];
  for (const proposal of proposals) {
    const profile = byName.get(proposal.name);
    if (profile === undefined) {
      lowered.push(proposal);
      continue;
    }
    const result = lowerOne(profile, proposal, definitions);
    if (!result.ok) {
      return {
        ok: false,
        error: {
          code: "profile-operation-invalid",
          toolCallId: proposal.toolCallId,
          name: proposal.name,
          reason: result.reason,
        },
      };
    }
    lowered.push({ ...proposal, name: result.toolName, arguments: result.arguments });
  }
  return { ok: true, value: lowered };
}

function lowerOne(
  profile: DisclosedOperationProfile,
  proposal: ProfileProposal,
  definitions: readonly OperationProfileDefinition[],
):
  | { readonly ok: true; readonly toolName: string; readonly arguments: Record<string, unknown> }
  | { readonly ok: false; readonly reason: ProfileOperationRefusal } {
  const input = proposal.arguments;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reason: "arguments-not-object" };
  }
  const record = input as Record<string, unknown>;
  const operation = record.operation;
  if (typeof operation !== "string" || operation === "") {
    return { ok: false, reason: "operation-missing" };
  }
  const member = profile.operations.find((candidate) => candidate.operation === operation);
  if (member === undefined) {
    const declared = definitions
      .find((definition) => definition.id === profile.profileId)
      ?.members.some((candidate) => candidate.operation === operation);
    return {
      ok: false,
      reason: declared === true ? "operation-not-disclosed" : "operation-unknown",
    };
  }
  // `operation` decides. Other operations' properties are ignored: strict-schema
  // dialects send them all as `null`, and lenient ones may echo them back.
  const nested = record[operation];
  if (nested === undefined || nested === null) {
    return { ok: true, toolName: member.toolName, arguments: {} };
  }
  if (typeof nested !== "object" || Array.isArray(nested)) {
    return { ok: false, reason: "operation-arguments-invalid" };
  }
  return { ok: true, toolName: member.toolName, arguments: nested as Record<string, unknown> };
}
