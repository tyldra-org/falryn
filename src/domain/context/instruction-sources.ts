/** Source choice is independent of instruction authority and executable admission. */
import { z } from "zod";
import { canonicalDigest, freezeMetadata } from "../extensions/canonical.ts";
import { digestSchema } from "../extensions/identity.ts";

export const INSTRUCTION_SOURCE_LIMITS = Object.freeze({
  sourceBytes: 1_048_576,
  admittedBytes: 8_388_608,
  cacheBytes: 16_777_216,
  pageEntries: 100,
  pageBytes: 262_144,
  deadlineMs: 30_000,
  references: 64,
});

const name = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (s) =>
      s.isWellFormed() &&
      s === s.normalize("NFC") &&
      [...s].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127),
  );
export const sourcePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (s) =>
      s.isWellFormed() &&
      s === s.normalize("NFC") &&
      !s.includes("\\") &&
      !s.startsWith("/") &&
      s.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
      [...s].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127),
  );
/** Execution definitions may narrow a workspace to a normalized subtree. */
export const instructionDirectorySchema = z
  .string()
  .max(4096)
  .refine((value) => value === "" || sourcePathSchema.safeParse(value).success);
export const instructionSourceIdentitySchema = z.strictObject({
  version: z.literal(1),
  kind: z.enum(["instruction", "skill", "prompt"]),
  root: name,
  path: sourcePathSchema,
  namespace: name,
  localId: name,
});
export type InstructionSourceIdentity = z.infer<typeof instructionSourceIdentitySchema>;
export function instructionSourceKey(identity: InstructionSourceIdentity): string {
  return canonicalDigest(instructionSourceIdentitySchema.parse(identity));
}

/** Origin is supplied by the discovery owner, never inferred from package prose. */
export const SOURCE_ORIGINS = [
  "builtin",
  "configured",
  "user-claude",
  "user-agents",
  "user-falryn",
  "project-claude",
  "project-agents",
  "project-falryn",
] as const;
export const instructionSourceSchema = z.strictObject({
  identity: instructionSourceIdentitySchema,
  digest: digestSchema.nullable(),
  origin: z.enum(SOURCE_ORIGINS),
  scope: z
    .string()
    .max(4_096)
    .refine((s) => s === "" || sourcePathSchema.safeParse(s).success),
  declaration: z.enum(["conventional", "explicit"]),
  enabled: z.boolean(),
  trusted: z.boolean(),
  compatible: z.boolean(),
  available: z.boolean(),
  /** Restriction absence is unknown, never an implicit permission. */
  eligibility: z.strictObject({ user: z.boolean(), automatic: z.boolean() }).nullable(),
  references: z.array(digestSchema).max(INSTRUCTION_SOURCE_LIMITS.references),
  /** Only declared conflicts are mechanically decidable; arbitrary prose is not. */
  conflicts: z.array(digestSchema).max(INSTRUCTION_SOURCE_LIMITS.references),
});
export type InstructionSource = z.infer<typeof instructionSourceSchema>;
export const sourcePreferencesSchema = z
  .strictObject({
    version: z.literal(1),
    choices: z
      .array(
        z.strictObject({
          kind: instructionSourceIdentitySchema.shape.kind,
          name: z.string().min(1).max(4353),
          source: digestSchema,
        }),
      )
      .max(1_024),
    restrictions: z
      .array(
        z.strictObject({
          source: digestSchema,
          user: z.boolean(),
          automatic: z.boolean(),
        }),
      )
      .max(1_024),
  })
  .superRefine((value, ctx) => {
    const choices = value.choices.map((item) => `${item.kind}:${item.name}`);
    if (
      new Set(choices).size !== choices.length ||
      new Set(value.restrictions.map((item) => item.source)).size !== value.restrictions.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate source control." });
  });
export type SourcePreferences = z.infer<typeof sourcePreferencesSchema>;
export const EMPTY_SOURCE_PREFERENCES: SourcePreferences = freezeMetadata({
  version: 1,
  choices: [],
  restrictions: [],
});
export const instructionScopeSchema = z.strictObject({
  root: name,
  directory: instructionDirectorySchema,
  execution: name,
  kind: z.enum(["main", "child", "workflow"]),
});
export type InstructionScope = z.infer<typeof instructionScopeSchema>;
export type SourceDecision = {
  readonly identity: InstructionSourceIdentity;
  readonly origin: InstructionSource["origin"];
  readonly scope: string;
  readonly source: string;
  readonly digest: string | null;
  readonly kind: InstructionSourceIdentity["kind"];
  readonly name: string;
  readonly namespace: string;
  readonly state: "selected" | "shadowed" | "excluded" | "conflicting";
  readonly reason: string;
};
export type SourceResolution = {
  readonly selected: readonly InstructionSource[];
  readonly decisions: readonly SourceDecision[];
  readonly unavailable: readonly string[];
};

const inside = (parent: string, child: string) =>
  parent === "" || child === parent || child.startsWith(`${parent}/`);
const project = (source: InstructionSource) => source.origin.startsWith("project-");
function rank(source: InstructionSource): number {
  return SOURCE_ORIGINS.indexOf(source.origin);
}
function compare(a: InstructionSource, b: InstructionSource): number {
  const depth = (source: InstructionSource) =>
    source.scope === "" ? 0 : source.scope.split("/").length;
  const scope = depth(a) - depth(b);
  const order =
    project(a) &&
    project(b) &&
    a.identity.kind === "instruction" &&
    b.identity.kind === "instruction"
      ? scope || rank(a) - rank(b)
      : rank(a) - rank(b) || scope;
  const left = instructionSourceKey(a.identity),
    right = instructionSourceKey(b.identity);
  return order || (left < right ? -1 : left > right ? 1 : 0);
}

/** Preferences choose a source; they cannot turn project content into user authority. */
export function resolveInstructionSources(input: {
  readonly sources: readonly InstructionSource[];
  readonly scope: InstructionScope;
  readonly preferences: SourcePreferences;
  readonly selections?: readonly {
    readonly kind: "skill" | "prompt";
    readonly name: string;
    readonly origin: "user" | "automatic";
  }[];
}): SourceResolution {
  const preferences = sourcePreferencesSchema.parse(input.preferences);
  const decisions = new Map<string, SourceDecision>();
  const eligible: InstructionSource[] = [];
  const selected: InstructionSource[] = [];
  const unavailable: string[] = [];
  const decide = (source: InstructionSource, state: SourceDecision["state"], reason: string) => {
    decisions.set(instructionSourceKey(source.identity), {
      identity: source.identity,
      origin: source.origin,
      scope: source.scope,
      source: instructionSourceKey(source.identity),
      digest: source.digest,
      kind: source.identity.kind,
      name: source.identity.localId,
      namespace: source.identity.namespace,
      state,
      reason,
    });
  };
  const contribution = (source: InstructionSource) =>
    JSON.stringify([
      source.identity.root,
      source.identity.namespace,
      source.identity.kind,
      source.identity.localId,
      source.identity.path,
      source.scope,
    ]);
  const explicitCounts = new Map<string, number>();
  for (const source of input.sources)
    if (source.declaration === "explicit") {
      const key = contribution(source);
      explicitCounts.set(key, (explicitCounts.get(key) ?? 0) + 1);
    }
  for (const source of input.sources) {
    const overrides = explicitCounts.get(contribution(source)) ?? 0;
    if (source.declaration === "conventional" && overrides === 1) {
      decide(source, "shadowed", "same-package-explicit-declaration");
      continue;
    }
    const reason =
      project(source) &&
      (source.identity.root !== input.scope.root || !inside(source.scope, input.scope.directory))
        ? "outside-execution-scope"
        : !source.enabled
          ? "disabled"
          : !source.trusted
            ? "untrusted"
            : !source.compatible
              ? "incompatible"
              : !source.available
                ? "unavailable"
                : null;
    if (reason) decide(source, "excluded", reason);
    else {
      eligible.push(source);
      decide(source, "excluded", "not-selected");
    }
  }
  const instructions = eligible.filter((source) => source.identity.kind === "instruction");
  const instructionGroups = new Map<string, InstructionSource[]>();
  for (const source of instructions) {
    const group = `${project(source) ? source.identity.root : "user"}:${source.scope}`;
    const groupSources = instructionGroups.get(group);
    if (groupSources) groupSources.push(source);
    else instructionGroups.set(group, [source]);
  }
  for (const [group, sources] of instructionGroups) {
    const preference = preferences.choices.find(
      (item) => item.kind === "instruction" && item.name === group,
    );
    if (preference) {
      const chosen = sources.find(
        (source) => instructionSourceKey(source.identity) === preference.source,
      );
      if (!chosen) unavailable.push(`preferred-source-unavailable:${preference.source}`);
      for (const source of sources) {
        if (source === chosen) {
          selected.push(source);
          decide(source, "selected", "explicit-preference");
        } else decide(source, "shadowed", "explicit-preference");
      }
    } else selected.push(...sources);
  }
  // A missing preferred instruction group must not disappear with its final source.
  for (const preference of preferences.choices.filter((item) => item.kind === "instruction")) {
    if (!instructionGroups.has(preference.name))
      unavailable.push(`preferred-source-unavailable:${preference.source}`);
  }
  for (const selection of input.selections ?? []) {
    const preference = preferences.choices.find(
      (item) => item.kind === selection.kind && item.name === selection.name,
    );
    let candidates = eligible.filter(
      (source) =>
        source.identity.kind === selection.kind &&
        (source.identity.localId === selection.name ||
          `${source.identity.namespace}/${source.identity.localId}` === selection.name),
    );
    if (preference) {
      for (const source of candidates)
        if (instructionSourceKey(source.identity) !== preference.source)
          decide(source, "shadowed", "explicit-preference");
      candidates = candidates.filter(
        (source) => instructionSourceKey(source.identity) === preference.source,
      );
    }
    candidates = candidates
      .filter((source) => {
        const restriction = preferences.restrictions.find(
          (item) => item.source === instructionSourceKey(source.identity),
        );
        const allowed =
          source.eligibility?.[selection.origin] === true &&
          restriction?.[selection.origin] !== false;
        if (!allowed) decide(source, "excluded", "invocation-restricted");
        return allowed;
      })
      .sort((a, b) => compare(b, a));
    const best = candidates[0];
    const tied = candidates.filter((candidate) => best && rank(candidate) === rank(best));
    if (!best) {
      unavailable.push(`selection-unavailable:${selection.name}`);
      continue;
    }
    if (tied.length > 1 || (selection.kind === "prompt" && candidates.length > 1 && !preference)) {
      for (const source of candidates) decide(source, "conflicting", "ambiguous-source");
      unavailable.push(`ambiguous-source:${selection.name}`);
      continue;
    }
    if (!selected.includes(best)) selected.push(best);
    decide(best, "selected", preference ? "explicit-preference" : "source-precedence");
    for (const source of candidates.slice(1)) decide(source, "shadowed", "source-precedence");
  }
  selected.sort(compare);
  const keys = new Set(selected.map((source) => instructionSourceKey(source.identity)));
  for (const source of selected) {
    if (source.conflicts.some((key) => keys.has(key))) {
      decide(source, "conflicting", "declared-instruction-conflict");
      unavailable.push(`instruction-conflict:${instructionSourceKey(source.identity)}`);
    } else if (decisions.get(instructionSourceKey(source.identity))?.state !== "selected")
      decide(source, "selected", "instruction-composition");
  }
  return freezeMetadata({ selected, decisions: [...decisions.values()], unavailable });
}
