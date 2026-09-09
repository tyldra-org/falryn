/** One inert catalog for built-in, user and admitted extension definitions. */
import { canonicalDigest, freezeMetadata } from "../../domain/extensions/canonical.ts";
import {
  builtinOwnerIdentityV1Schema,
  packageIdentityV1Schema,
} from "../../domain/extensions/identity.ts";
import type { AgentModelDefinition } from "../../providers/configuration/model-selection.ts";
import { contributionIdentitySchema } from "../../providers/configuration/policy-schema.ts";
import {
  type AgentDefinition,
  agentDefinitionId,
  decodeAgentDefinition,
  type RegisteredAgent,
} from "./agent-definition.ts";

export type AgentRegistration = {
  readonly definition: unknown;
  readonly owner: unknown;
  /** Set by the native admission owner, never read from the definition. */
  readonly provenance: RegisteredAgent["provenance"];
  readonly availability: RegisteredAgent["availability"];
  readonly reason: string | null;
};

export function createAgentRegistry(initial: readonly AgentRegistration[] = []) {
  const entries = new Map<string, RegisteredAgent>();
  let generation = 0;
  const register = (input: AgentRegistration, expectedDigest: string | null) => {
    const parsed = decodeAgentDefinition(input.definition);
    if (!parsed.ok) return parsed;
    const { definition, digest } = parsed;
    const owner =
      input.provenance === "built-in"
        ? builtinOwnerIdentityV1Schema.safeParse(input.owner)
        : packageIdentityV1Schema.safeParse(input.owner);
    if (
      !owner.success ||
      canonicalDigest(owner.data) !== definition.identity.owner.digest ||
      definition.identity.owner.kind !== (input.provenance === "built-in" ? "builtin" : "package")
    )
      return { ok: false as const, code: "agent-owner-mismatch" };
    const source =
      "nativeOwnerId" in owner.data
        ? `builtin/${owner.data.nativeOwnerId}`
        : input.provenance === "user"
          ? "user"
          : `package/${owner.data.packageId}`;
    const id = `${source}/${agentDefinitionId(definition)}`;
    if (!contributionIdentitySchema.safeParse(id).success)
      return { ok: false as const, code: "invalid-agent-identity" };
    const previous = entries.get(id);
    if ((previous?.digest ?? null) !== expectedDigest)
      return { ok: false as const, code: "stale-agent-definition" };
    const value: RegisteredAgent = freezeMetadata({
      definition,
      digest,
      id,
      provenance: input.provenance,
      availability: input.availability,
      reason: input.reason,
    });
    entries.set(id, value);
    generation++;
    return { ok: true as const, value };
  };
  for (const entry of initial) {
    const result = register(entry, null);
    if (!result.ok) throw new Error(result.code);
  }
  return {
    generation: () => generation,
    register,
    resolve: (id: string) => entries.get(id) ?? null,
    page(search = "", offset = 0) {
      const query = search.slice(0, 256).toLowerCase();
      const found = [...entries.values()]
        .filter((entry) => `${entry.id} ${entry.definition.label}`.toLowerCase().includes(query))
        .sort((a, b) => a.id.localeCompare(b.id));
      const start = Math.max(0, Math.trunc(offset));
      return {
        entries: found.slice(start, start + 50),
        nextOffset: start + 50 < found.length ? start + 50 : null,
        total: found.length,
      };
    },
    models(): readonly AgentModelDefinition[] {
      return [...entries.values()].map((entry) => ({
        kind: "agent",
        id: entry.id,
        label: entry.definition.label,
        revision: entry.digest,
        schemaRevision: 1,
        provenance: entry.provenance,
        availability: entry.availability,
        unavailableReason: entry.reason,
        ...(entry.definition.model === undefined ? {} : { model: entry.definition.model }),
        ...(entry.definition.preset === undefined ? {} : { preset: entry.definition.preset }),
      }));
    },
  };
}
export type AgentRegistry = ReturnType<typeof createAgentRegistry>;

const text = { type: "string", maxLength: 8192 };
const texts = { type: "array", items: text, maxItems: 64 };
const inputSchema = {
  type: "object",
  properties: { objective: { ...text, minLength: 1 } },
  required: ["objective"],
  additionalProperties: false,
};
const roster = [
  [
    "general",
    "General",
    "medium",
    "Perform bounded mixed work within the delegated authority.",
    ["outcome", "evidence", "changes", "checks", "unresolved"],
  ],
  [
    "explorer",
    "Explorer",
    "small",
    "Inspect local code and trace its behavior. Do not edit or publish.",
    ["locations", "flow", "findings", "unknowns"],
  ],
  [
    "researcher",
    "Researcher",
    "medium",
    "Investigate admitted sources. Cite inspected evidence, distinguish contradictions and uncertainty. Do not submit forms, alter accounts or publish.",
    ["sources", "findings", "coverage", "contradictions", "uncertainty"],
  ],
  [
    "planner",
    "Planner",
    "big",
    "Produce a bounded plan from evidence. Do not implement or launch the plan.",
    ["scope", "steps", "checks", "risks", "decisions"],
  ],
  [
    "implementer",
    "Implementer",
    "medium",
    "Apply the delegated change and report actual checks. Commit and publication require separate explicit effect authority.",
    ["changes", "checks", "failures", "limitations"],
  ],
  [
    "reviewer",
    "Reviewer",
    "big",
    "Independently inspect the subject and return located findings with severity and evidence. Do not repair it.",
    ["findings", "gaps", "inconclusive", "evidence"],
  ],
] as const;

export function starterAgentRegistrations(): readonly AgentRegistration[] {
  const owner = {
    version: 1,
    release: "0.0.0",
    buildDigest: canonicalDigest(roster),
    nativeOwnerId: "falryn",
    catalogGeneration: 1,
  } as const;
  return roster.map(([localId, label, preset, instructions, fields]) => {
    const descriptor = {
      version: 1 as const,
      label,
      purpose: instructions,
      instructions,
      inputSchema,
      resultSchema: {
        type: "object",
        properties: Object.fromEntries(fields.map((field) => [field, texts])),
        required: [...fields],
        additionalProperties: false,
      },
      capabilities: { required: [], optional: [] },
      effects:
        localId === "general" || localId === "implementer"
          ? (["observation", "mutation", "external", "interactive"] as AgentDefinition["effects"])
          : (["observation"] as AgentDefinition["effects"]),
      context: "selected-evidence" as const,
      workspace: "inherited" as const,
      modelRole: "subagents" as const,
      preset,
      limits: {},
      concurrencyClass: "inherited" as const,
      nestedDelegation: localId === "general" || localId === "implementer",
      completionCriteria: [
        "Return the required structured fields.",
        "Cite observed evidence; report missing or inconclusive checks without asserting broader task verification.",
      ],
      cancellation: "propagate" as const,
    };
    return {
      owner,
      provenance: "built-in" as const,
      availability: "available" as const,
      reason: null,
      definition: {
        ...descriptor,
        identity: {
          version: 1,
          owner: { kind: "builtin", digest: canonicalDigest(owner) },
          nativeKind: "agent",
          namespace: "agents",
          localId,
          descriptorDigest: canonicalDigest(descriptor),
        },
      },
    };
  });
}
