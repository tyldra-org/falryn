import {
  bytesDigest,
  canonicalDigest,
  freezeMetadata,
  parseMetadata,
} from "../../domain/extensions/canonical.ts";
import {
  contributionIdentityV1Schema,
  decodeIdentity,
  type StandaloneSourceOwnerV1,
  standaloneSourceOwnerV1Schema,
} from "../../domain/extensions/identity.ts";
import { PORTABLE_MCP_SCHEMA } from "../../domain/extensions/manifest.ts";
import { portableComponents } from "./portable-components.ts";

/** A standalone declaration remains source-owned. It is never a synthetic installed package. */
export function prepareStandaloneSource(input: {
  readonly kind: StandaloneSourceOwnerV1["kind"];
  readonly id: string;
  readonly namespace: string;
  readonly bytes: Uint8Array;
  readonly provenance: unknown;
  readonly owner: Omit<
    StandaloneSourceOwnerV1,
    "version" | "kind" | "contentDigest" | "provenanceDigest"
  >;
}) {
  try {
    if (
      input.bytes.length > 1_048_576 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(input.id) ||
      input.id.length > 64
    )
      return { ok: false as const, code: "invalid-standalone-source" };
    const owner = decodeIdentity(standaloneSourceOwnerV1Schema, {
      ...input.owner,
      version: 1,
      kind: input.kind,
      contentDigest: bytesDigest(input.bytes),
      provenanceDigest: canonicalDigest(input.provenance),
    });
    if (!owner.ok) return owner;
    const path =
      input.kind === "skill"
        ? `skills/${input.id}/SKILL.md`
        : input.kind === "prompt"
          ? `prompts/${input.id}.md`
          : "mcp.json";
    const bytes =
      input.kind === "mcp-connection"
        ? new TextEncoder().encode(
            JSON.stringify({
              $schema: PORTABLE_MCP_SCHEMA,
              mcpServers: {
                [input.id]: parseMetadata(
                  new TextDecoder("utf-8", { fatal: true }).decode(input.bytes),
                ),
              },
            }),
          )
        : input.bytes;
    const components = portableComponents(new Map([[path, bytes]]), () => {});
    const component = components[0];
    if (components.length !== 1 || component === undefined)
      return { ok: false as const, code: "invalid-standalone-source" };
    const declaration = { kind: input.kind, metadata: component.metadata };
    const identity = decodeIdentity(contributionIdentityV1Schema, {
      version: 1,
      owner: { kind: "standalone", digest: owner.digest },
      nativeKind: input.kind,
      namespace: input.namespace,
      localId: input.id,
      descriptorDigest: canonicalDigest(declaration),
    });
    if (!identity.ok) return identity;
    return freezeMetadata({
      ok: true as const,
      owner: owner.value,
      ownerDigest: owner.digest,
      identity: identity.value,
      identityDigest: identity.digest,
      declaration,
      state: "declared" as const,
    });
  } catch {
    return { ok: false as const, code: "invalid-standalone-source" };
  }
}
