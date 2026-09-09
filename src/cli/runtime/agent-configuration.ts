/** User definitions use the established configuration file, validation and revision owner. */
import { z } from "zod";
import { agentDefinitionSchema } from "../../application/orchestration/agent-definition.ts";
import {
  createAgentRegistry,
  starterAgentRegistrations,
} from "../../application/orchestration/agent-registry.ts";
import { type ConfigurationKeyDeclaration, objectKey } from "../../config/index.ts";
import type { ConfigurationValues } from "../../domain/configuration/index.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { identityText } from "../../domain/extensions/identity.ts";

export const AGENT_CONFIGURATION_KEY = "agents.definitions";
const descriptorSchema = agentDefinitionSchema.omit({ identity: true });
export const userAgentDefinitionsSchema = z.strictObject({
  version: z.literal(1),
  entries: z
    .array(
      z.strictObject({
        namespace: identityText,
        localId: identityText,
        enabled: z.boolean(),
        definition: descriptorSchema,
      }),
    )
    .superRefine((entries, ctx) => {
      const ids = new Set<string>();
      for (const entry of entries) {
        const id = `${entry.namespace}:${entry.localId}`;
        if (ids.has(id)) ctx.addIssue({ code: "custom", message: "Duplicate agent identity." });
        ids.add(id);
        const registered = createAgentRegistry().register(userRegistration(entry), null);
        if (!registered.ok) ctx.addIssue({ code: "custom", message: registered.code });
      }
    }),
});
export const AGENT_CONFIGURATION_KEYS: readonly ConfigurationKeyDeclaration[] = [
  objectKey({
    path: AGENT_CONFIGURATION_KEY,
    summary:
      "Custom agent definitions. Saving registers inert definitions; launching requires separate authority.",
    objectSchema: userAgentDefinitionsSchema,
    defaultValue: { version: 1, entries: [] },
    scopes: ["user", "profile"],
    applicationClass: "next-operation",
    sensitivity: "public",
  }),
];

export function agentRegistryFrom(values: ConfigurationValues) {
  const registry = createAgentRegistry(starterAgentRegistrations());
  const configured = userAgentDefinitionsSchema.parse(
    values[AGENT_CONFIGURATION_KEY] ?? { version: 1, entries: [] },
  );
  for (const entry of configured.entries) {
    const registered = registry.register(userRegistration(entry), null);
    if (!registered.ok) throw new Error(registered.code);
  }
  return registry;
}

function userRegistration(entry: {
  namespace: string;
  localId: string;
  enabled: boolean;
  definition: z.infer<typeof descriptorSchema>;
}) {
  const digest = canonicalDigest(entry.definition);
  const owner = {
    version: 1,
    packageId: "user",
    packageVersion: null,
    sourceCoordinate: {
      kind: "local",
      rootId: "configuration",
      path: "agents.definitions",
      sourceDigest: digest,
    },
    packageDigest: digest,
    manifestDigest: digest,
  };
  return {
    owner,
    provenance: "user" as const,
    availability: entry.enabled ? ("available" as const) : ("disabled" as const),
    reason: entry.enabled ? null : "agent-disabled-by-user",
    definition: {
      ...entry.definition,
      identity: {
        version: 1,
        owner: { kind: "package", digest: canonicalDigest(owner) },
        nativeKind: "agent",
        namespace: entry.namespace,
        localId: entry.localId,
        descriptorDigest: digest,
      },
    },
  };
}
