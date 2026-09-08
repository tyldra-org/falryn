/** Shared extension identities. Display and health information is never identity. */
import { valid } from "semver";
import { z } from "zod";
import {
  canonicalDigest,
  canonicalJson,
  freezeMetadata,
  packageRelativePath,
} from "./canonical.ts";

export const identityText = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/\p{Cc}/u.test(value) && value.trim() === value);
export const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const generationSchema = z.int().nonnegative();
export const exactVersionSchema = z
  .string()
  .max(256)
  .refine((value) => valid(value) !== null && !/^[v=\s]/u.test(value));
export const relativePathSchema = z.string().transform((value, ctx) => {
  const path = packageRelativePath(value);
  if (path === null) {
    ctx.addIssue({ code: "custom", message: "unsafe-package-path" });
    return z.NEVER;
  }
  return path;
});
export const EXTENSION_SCOPES = ["user", "workspace", "session", "process", "development"] as const;
export const NATIVE_CONTRIBUTION_KINDS = [
  "tool",
  "composed-tool",
  "mcp-server",
  "mcp-tool",
  "mcp-resource",
  "mcp-prompt",
  "mcp-connection",
  "skill",
  "instruction",
  "rule",
  "template",
  "asset",
  "prompt",
  "hook",
  "command",
  "agent",
  "subagent",
  "workflow",
  "automation",
  "schedule",
  "peer-messaging-adapter",
  "provider",
  "model-role-adapter",
  "theme",
  "status-line",
  "panel",
  "overlay",
  "notification",
  "keymap",
  "settings",
  "help",
  "capability-module",
] as const;
export const BEHAVIOR_FAMILIES = [
  "search",
  "read",
  "edit",
  "run",
  "browser",
  "computer",
  "delegate",
  "capability",
] as const;
const sourceUrl = z
  .string()
  .max(2_048)
  .transform((value, ctx) => {
    try {
      const url = new URL(value.replace(/^git@([^:]+):/u, "ssh://git@$1/"));
      if (
        !["https:", "http:", "ssh:"].includes(url.protocol) ||
        url.password !== "" ||
        (url.username !== "" && !(url.protocol === "ssh:" && url.username === "git")) ||
        url.search !== "" ||
        url.hash !== ""
      )
        throw new Error("invalid-source-url");
      return url.href;
    } catch {
      ctx.addIssue({ code: "custom", message: "invalid-source-url" });
      return z.NEVER;
    }
  });
export const sourceCoordinateSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("builtin"),
    release: exactVersionSchema,
    buildDigest: digestSchema,
  }),
  z.strictObject({
    kind: z.literal("registry"),
    registry: sourceUrl,
    coordinate: identityText,
    packageVersion: exactVersionSchema,
  }),
  z.strictObject({
    kind: z.literal("git"),
    repository: sourceUrl,
    commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
  }),
  z.strictObject({ kind: z.literal("archive"), origin: sourceUrl, digest: digestSchema }),
  z.strictObject({
    kind: z.literal("local"),
    rootId: identityText,
    path: relativePathSchema,
    sourceDigest: digestSchema,
  }),
]);
export const builtinOwnerIdentityV1Schema = z.strictObject({
  version: z.literal(1),
  release: exactVersionSchema,
  buildDigest: digestSchema,
  nativeOwnerId: identityText,
  catalogGeneration: generationSchema,
});
export const packageIdentityV1Schema = z
  .strictObject({
    version: z.literal(1),
    packageId: identityText,
    packageVersion: exactVersionSchema.nullable(),
    sourceCoordinate: sourceCoordinateSchema,
    packageDigest: digestSchema,
    manifestDigest: digestSchema,
  })
  .refine(
    (value) =>
      value.sourceCoordinate.kind !== "registry" ||
      value.sourceCoordinate.packageVersion === value.packageVersion,
  );
export const extensionActivationIdentityV1Schema = z.strictObject({
  version: z.literal(1),
  packageIdentityDigest: digestSchema,
  scope: z.enum(EXTENSION_SCOPES),
  scopeAuthorityId: identityText,
  scopeAuthorityGeneration: generationSchema,
  configurationGeneration: generationSchema,
  activationRevision: generationSchema,
  catalogGeneration: generationSchema,
});
export const standaloneSourceOwnerV1Schema = z.strictObject({
  version: z.literal(1),
  kind: z.enum(["skill", "prompt", "mcp-connection"]),
  sourceCoordinate: sourceCoordinateSchema,
  contentDigest: digestSchema,
  provenanceDigest: digestSchema,
  scope: z.enum(EXTENSION_SCOPES),
  scopeAuthorityId: identityText,
  scopeAuthorityGeneration: generationSchema,
  catalogGeneration: generationSchema,
});
export const contributionIdentityV1Schema = z
  .strictObject({
    version: z.literal(1),
    owner: z.strictObject({
      kind: z.enum(["builtin", "package", "standalone"]),
      digest: digestSchema,
    }),
    nativeKind: z.enum(NATIVE_CONTRIBUTION_KINDS),
    namespace: identityText,
    localId: identityText,
    descriptorDigest: digestSchema,
  })
  .refine(
    (value) =>
      value.owner.kind !== "standalone" ||
      ["skill", "prompt", "mcp-connection"].includes(value.nativeKind),
  );
export const capabilityBindingV1Schema = z.strictObject({
  version: z.literal(1),
  contributionIdentityDigest: digestSchema,
  extensionActivationDigest: digestSchema.optional(),
  nativeRegistryOwner: identityText,
  nativeRegistryGeneration: generationSchema,
  actionId: identityText,
  family: z.enum(BEHAVIOR_FAMILIES),
  schemaDigest: digestSchema,
  effectDigest: digestSchema,
  authorityDigest: digestSchema,
  resultDigest: digestSchema,
  settlementDigest: digestSchema,
  catalogGeneration: generationSchema,
});

export type BuiltinOwnerIdentityV1 = z.infer<typeof builtinOwnerIdentityV1Schema>;
export type PackageIdentityV1 = z.infer<typeof packageIdentityV1Schema>;
export type ExtensionActivationIdentityV1 = z.infer<typeof extensionActivationIdentityV1Schema>;
export type StandaloneSourceOwnerV1 = z.infer<typeof standaloneSourceOwnerV1Schema>;
export type ContributionIdentityV1 = z.infer<typeof contributionIdentityV1Schema>;
export type CapabilityBindingV1 = z.infer<typeof capabilityBindingV1Schema>;

export function decodeIdentity<T>(
  schema: z.ZodType<T>,
  input: unknown,
):
  | { readonly ok: true; readonly value: T; readonly digest: string }
  | { readonly ok: false; readonly code: "invalid-identity" } {
  try {
    const parsed = schema.safeParse(JSON.parse(canonicalJson(input)));
    if (!parsed.success) return { ok: false, code: "invalid-identity" };
    return { ok: true, value: freezeMetadata(parsed.data), digest: canonicalDigest(parsed.data) };
  } catch {
    return { ok: false, code: "invalid-identity" };
  }
}

/** Linking records is separate from parsing; a digest alone grants no authority. */
export function validateCapabilityBinding(input: {
  readonly contribution: ContributionIdentityV1;
  readonly binding: CapabilityBindingV1;
  readonly activation?: ExtensionActivationIdentityV1;
  readonly state: "declared" | "enabled" | "available" | "selected" | "executable";
}): boolean {
  const contribution = decodeIdentity(contributionIdentityV1Schema, input.contribution);
  const binding = decodeIdentity(capabilityBindingV1Schema, input.binding);
  if (
    !contribution.ok ||
    !binding.ok ||
    binding.value.contributionIdentityDigest !== contribution.digest
  )
    return false;
  if (contribution.value.owner.kind !== "package")
    return input.activation === undefined && binding.value.extensionActivationDigest === undefined;
  if (input.activation === undefined)
    return input.state === "declared" && binding.value.extensionActivationDigest === undefined;
  const activation = decodeIdentity(extensionActivationIdentityV1Schema, input.activation);
  return (
    activation.ok &&
    activation.value.packageIdentityDigest === contribution.value.owner.digest &&
    activation.digest === binding.value.extensionActivationDigest &&
    activation.value.catalogGeneration === binding.value.catalogGeneration
  );
}
