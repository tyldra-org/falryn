/**
 * Capability registry: stable tool identities, manifests, schemas, capabilities,
 * and effect classes for one immutable catalog generation.
 *
 * Untrusted manifest documents (config, MCP, plugins) are validated with Zod at
 * this boundary. Trusted adapters attach Zod input/output schemas when they
 * register. The resulting catalog feeds the #44 tool-pipeline bind path;
 * registry-backed validate/normalize before dispatch is `tool-invocation.ts`
 * (#49). Policy and focused confirmation are `tool-policy.ts` (#50).
 * Scheduling, cancel, timeout, and join are `tool-schedule.ts` (#51).
 * Typed results live in `tool-result.ts` (#52). Lifecycle hook points live in
 * `tool-hooks.ts` (#53).
 */

import { z } from "zod";

import { toCodecIssues } from "./branded-schema.ts";
import type { CodecIssue } from "./codec-error.ts";
import type { CapabilityId, ConfigurationGeneration } from "./identity.ts";
import { capabilityId } from "./identity.ts";
import { MAX_IDENTIFIER_LENGTH } from "./limits.ts";
import { err, ok, type Result } from "./result.ts";
import { createToolCatalog, type ToolCatalog, type ToolDescriptor } from "./tool-pipeline.ts";
import { type ConflictKey, EFFECT_CLASSES, type EffectClass, isEffectClass } from "./work.ts";

/** Schema version this build writes for tool registry generations. */
export const TOOL_REGISTRY_SCHEMA_VERSION = 1;

/** Hard cap on tools admitted into one registry generation. */
export const MAX_TOOL_REGISTRY_ENTRIES = 512;

/** Default max UTF-8 bytes for one tool description in a manifest document. */
export const DEFAULT_TOOL_DESCRIPTION_MAX_BYTES = 4 * 1024;

/** Hard cap on tool description bytes. */
export const MAX_TOOL_DESCRIPTION_BYTES = 16 * 1024;

/** Default max input bytes declared on a tool. */
export const DEFAULT_TOOL_MAX_INPUT_BYTES = 256 * 1024;

/** Hard cap on declared max input bytes. */
export const MAX_TOOL_MAX_INPUT_BYTES = 8 * 1024 * 1024;

/** Default max output bytes declared on a tool. */
export const DEFAULT_TOOL_MAX_OUTPUT_BYTES = 1024 * 1024;

/** Hard cap on declared max output bytes. */
export const MAX_TOOL_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * Where a descriptor was published from.
 *
 * Precedence is explicit at merge time: a later source cannot silently shadow
 * a built-in. Collisions remain visible as registry errors.
 */
export const TOOL_SOURCES = ["builtin", "integration", "mcp", "plugin", "workflow"] as const;

export type ToolSource = (typeof TOOL_SOURCES)[number];

export function isToolSource(value: unknown): value is ToolSource {
  return typeof value === "string" && (TOOL_SOURCES as readonly string[]).includes(value);
}

/**
 * Capability kind for discovery and selection — not an execution route.
 */
export const TOOL_CAPABILITY_KINDS = [
  "filesystem",
  "process",
  "git",
  "search",
  "network",
  "browser",
  "computer-use",
  "lsp",
  "dap",
  "mcp",
  "plugin",
  "composite",
  "other",
] as const;

export type ToolCapabilityKind = (typeof TOOL_CAPABILITY_KINDS)[number];

export function isToolCapabilityKind(value: unknown): value is ToolCapabilityKind {
  return typeof value === "string" && (TOOL_CAPABILITY_KINDS as readonly string[]).includes(value);
}

export const TOOL_PLATFORM_OSES = ["darwin", "linux", "win32"] as const;
export type ToolPlatformOs = (typeof TOOL_PLATFORM_OSES)[number];

export const TOOL_PLATFORM_ARCHES = ["arm64", "x64"] as const;
export type ToolPlatformArch = (typeof TOOL_PLATFORM_ARCHES)[number];

/**
 * Stable tool identity: namespace, name, version, and source.
 *
 * Encoded as a {@link CapabilityId} via {@link encodeToolIdentity}.
 */
export type ToolIdentity = {
  readonly namespace: string;
  readonly name: string;
  readonly version: number;
  readonly source: ToolSource;
};

export type PlatformConstraint = {
  readonly os: readonly ToolPlatformOs[];
  readonly arch: readonly ToolPlatformArch[];
};

export type ToolLimits = {
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  /** Null means no descriptor-declared default deadline. */
  readonly defaultTimeoutMs: number | null;
};

export type ConcurrencyContract = {
  /** Null means no global cap beyond the pipeline iteration bounds. */
  readonly maxGlobal: number | null;
  /** Null means no per-workspace cap beyond the pipeline iteration bounds. */
  readonly maxPerWorkspace: number | null;
};

export type ProjectionContract = {
  readonly modelMaxBytes: number;
  readonly redactSensitive: boolean;
};

/**
 * Untrusted manifest document shape (config / MCP / plugin metadata).
 *
 * Input and output Zod schemas are never carried on the wire; trusted adapters
 * attach them at registration.
 */
export type ToolManifestDocument = {
  readonly namespace: string;
  readonly name: string;
  readonly version: number;
  readonly source: ToolSource;
  readonly title: string;
  readonly description: string;
  readonly effect: EffectClass;
  readonly capabilityKind: ToolCapabilityKind;
  readonly platforms: readonly PlatformConstraint[];
  readonly limits: ToolLimits;
  readonly concurrency: ConcurrencyContract;
  readonly resultProjection: ProjectionContract;
};

/**
 * Trusted in-memory manifest after document validation and schema attachment.
 */
export type ToolManifest = ToolManifestDocument & {
  readonly identity: ToolIdentity;
  readonly capabilityId: CapabilityId;
  readonly inputSchema: z.ZodType<Readonly<Record<string, unknown>>>;
  readonly outputSchema: z.ZodType<Readonly<Record<string, unknown>>>;
  readonly conflictKeysFor?: (input: Readonly<Record<string, unknown>>) => readonly ConflictKey[];
};

export type ToolRegistryEntry = {
  readonly manifest: ToolManifest;
  readonly descriptor: ToolDescriptor;
};

export type ToolRegistry = {
  readonly schemaVersion: typeof TOOL_REGISTRY_SCHEMA_VERSION;
  readonly generation: ConfigurationGeneration;
  readonly entries: readonly ToolRegistryEntry[];
  /** Catalog view for the #44 bind/validate path. */
  readonly catalog: ToolCatalog;
  resolveByName(name: string): ToolRegistryEntry | null;
  resolveByCapabilityId(id: CapabilityId): ToolRegistryEntry | null;
  resolveByIdentity(identity: ToolIdentity): ToolRegistryEntry | null;
};

export type ToolIdentityError =
  | { readonly code: "empty-namespace" }
  | { readonly code: "empty-name" }
  | { readonly code: "invalid-version" }
  | { readonly code: "invalid-source"; readonly source: string }
  | { readonly code: "identifier-too-long" }
  | { readonly code: "identifier-illegal-character"; readonly field: "namespace" | "name" }
  | { readonly code: "malformed-capability-id" };

export type ToolRegistryError =
  | { readonly code: "too-many-entries"; readonly maximum: number; readonly attempted: number }
  | { readonly code: "duplicate-name"; readonly name: string }
  | { readonly code: "duplicate-capability-id"; readonly capabilityId: CapabilityId }
  | { readonly code: "builtin-shadowed"; readonly name: string; readonly source: ToolSource }
  | { readonly code: "invalid-identity"; readonly reason: ToolIdentityError }
  | { readonly code: "invalid-descriptor"; readonly reason: "invalid-effect" | "empty-title" }
  | { readonly code: "invalid-manifest-document"; readonly issues: readonly CodecIssue[] };

const LEGAL_SEGMENT = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

const platformConstraintSchema = z
  .object({
    os: z.array(z.enum(TOOL_PLATFORM_OSES)).max(TOOL_PLATFORM_OSES.length),
    arch: z.array(z.enum(TOOL_PLATFORM_ARCHES)).max(TOOL_PLATFORM_ARCHES.length),
  })
  .strict();

const toolLimitsSchema = z
  .object({
    maxInputBytes: z.int().min(1).max(MAX_TOOL_MAX_INPUT_BYTES),
    maxOutputBytes: z.int().min(1).max(MAX_TOOL_MAX_OUTPUT_BYTES),
    defaultTimeoutMs: z.int().min(1).nullable(),
  })
  .strict();

const concurrencyContractSchema = z
  .object({
    maxGlobal: z.int().min(1).nullable(),
    maxPerWorkspace: z.int().min(1).nullable(),
  })
  .strict();

const projectionContractSchema = z
  .object({
    modelMaxBytes: z.int().min(1).max(MAX_TOOL_MAX_OUTPUT_BYTES),
    redactSensitive: z.boolean(),
  })
  .strict();

const toolManifestDocumentSchema: z.ZodType<ToolManifestDocument> = z
  .object({
    namespace: z.string().min(1).max(MAX_IDENTIFIER_LENGTH),
    name: z.string().min(1).max(MAX_IDENTIFIER_LENGTH),
    version: z.int().min(1),
    source: z.enum(TOOL_SOURCES),
    title: z.string().min(1).max(MAX_IDENTIFIER_LENGTH),
    description: z.string().max(MAX_TOOL_DESCRIPTION_BYTES),
    effect: z.enum(EFFECT_CLASSES),
    capabilityKind: z.enum(TOOL_CAPABILITY_KINDS),
    platforms: z.array(platformConstraintSchema).max(8),
    limits: toolLimitsSchema,
    concurrency: concurrencyContractSchema,
    resultProjection: projectionContractSchema,
  })
  .strict();

/**
 * Encode stable identity as a branded {@link CapabilityId}.
 *
 * Form: `<source>:<namespace>/<name>@<version>`
 */
export function encodeToolIdentity(
  identity: ToolIdentity,
): Result<CapabilityId, ToolIdentityError> {
  const validated = validateToolIdentity(identity);
  if (!validated.ok) {
    return validated;
  }
  const encoded = `${identity.source}:${identity.namespace}/${identity.name}@${identity.version}`;
  if (encoded.length > MAX_IDENTIFIER_LENGTH) {
    return err({ code: "identifier-too-long" });
  }
  const parsed = capabilityId.parse(encoded);
  if (!parsed.ok) {
    if (parsed.error.code === "identifier-illegal-character") {
      return err({ code: "identifier-illegal-character", field: "name" });
    }
    return err({ code: "identifier-too-long" });
  }
  return ok(parsed.value);
}

/**
 * Decode a capability id produced by {@link encodeToolIdentity}.
 */
export function decodeToolIdentity(id: CapabilityId): Result<ToolIdentity, ToolIdentityError> {
  const match = /^([^:]+):([^/]+)\/([^@]+)@(\d+)$/.exec(id);
  if (match === null) {
    return err({ code: "malformed-capability-id" });
  }
  const [, sourceRaw, namespace, name, versionRaw] = match;
  if (
    sourceRaw === undefined ||
    namespace === undefined ||
    name === undefined ||
    versionRaw === undefined
  ) {
    return err({ code: "malformed-capability-id" });
  }
  if (!isToolSource(sourceRaw)) {
    return err({ code: "invalid-source", source: sourceRaw });
  }
  const version = Number(versionRaw);
  return validateToolIdentity({
    namespace,
    name,
    version,
    source: sourceRaw,
  });
}

export function validateToolIdentity(
  identity: ToolIdentity,
): Result<ToolIdentity, ToolIdentityError> {
  if (identity.namespace.length === 0) {
    return err({ code: "empty-namespace" });
  }
  if (identity.name.length === 0) {
    return err({ code: "empty-name" });
  }
  if (!Number.isInteger(identity.version) || identity.version < 1) {
    return err({ code: "invalid-version" });
  }
  if (!isToolSource(identity.source)) {
    return err({ code: "invalid-source", source: String(identity.source) });
  }
  if (!LEGAL_SEGMENT.test(identity.namespace)) {
    return err({ code: "identifier-illegal-character", field: "namespace" });
  }
  if (!LEGAL_SEGMENT.test(identity.name)) {
    return err({ code: "identifier-illegal-character", field: "name" });
  }
  if (
    identity.namespace.length > MAX_IDENTIFIER_LENGTH ||
    identity.name.length > MAX_IDENTIFIER_LENGTH
  ) {
    return err({ code: "identifier-too-long" });
  }
  return ok(identity);
}

/** Parse an untrusted manifest document; never returns rejected field values. */
export function parseToolManifestDocument(
  value: unknown,
): Result<ToolManifestDocument, readonly CodecIssue[]> {
  const parsed = toolManifestDocumentSchema.safeParse(value);
  if (!parsed.success) {
    return err(toCodecIssues(parsed.error));
  }
  const document = parsed.data;
  const identityResult = validateToolIdentity({
    namespace: document.namespace,
    name: document.name,
    version: document.version,
    source: document.source,
  });
  if (!identityResult.ok) {
    return err([{ path: "identity", code: identityResult.error.code }]);
  }
  return ok(document);
}

export type RegisterToolSchemas = {
  readonly inputSchema: z.ZodType<Readonly<Record<string, unknown>>>;
  readonly outputSchema: z.ZodType<Readonly<Record<string, unknown>>>;
  readonly conflictKeysFor?: (input: Readonly<Record<string, unknown>>) => readonly ConflictKey[];
};

/**
 * Build a trusted registry entry from a validated document plus Zod schemas.
 */
export function createToolRegistryEntry(
  document: ToolManifestDocument,
  schemas: RegisterToolSchemas,
): Result<ToolRegistryEntry, ToolRegistryError> {
  const identity: ToolIdentity = {
    namespace: document.namespace,
    name: document.name,
    version: document.version,
    source: document.source,
  };
  const identityResult = validateToolIdentity(identity);
  if (!identityResult.ok) {
    return err({ code: "invalid-identity", reason: identityResult.error });
  }
  if (document.title.length === 0) {
    return err({ code: "invalid-descriptor", reason: "empty-title" });
  }
  if (!isEffectClass(document.effect)) {
    return err({ code: "invalid-descriptor", reason: "invalid-effect" });
  }
  const encoded = encodeToolIdentity(identity);
  if (!encoded.ok) {
    return err({ code: "invalid-identity", reason: encoded.error });
  }

  const manifest: ToolManifest = {
    ...document,
    identity,
    capabilityId: encoded.value,
    inputSchema: schemas.inputSchema,
    outputSchema: schemas.outputSchema,
    ...(schemas.conflictKeysFor === undefined ? {} : { conflictKeysFor: schemas.conflictKeysFor }),
  };

  const descriptor: ToolDescriptor = {
    id: manifest.capabilityId,
    version: manifest.version,
    name: manifest.name,
    effect: manifest.effect,
    inputSchema: manifest.inputSchema,
    expectedOutputBytes: manifest.limits.maxOutputBytes,
    ...(manifest.conflictKeysFor === undefined
      ? {}
      : { conflictKeysFor: manifest.conflictKeysFor }),
  };

  return ok({ manifest, descriptor });
}

/**
 * Build an immutable registry for one configuration generation.
 *
 * Duplicate catalog names or capability ids fail closed. A non-builtin entry
 * that reuses a builtin catalog name is reported as `builtin-shadowed`.
 */
export function createToolRegistry(
  generation: ConfigurationGeneration,
  entries: readonly ToolRegistryEntry[],
): Result<ToolRegistry, ToolRegistryError> {
  if (entries.length > MAX_TOOL_REGISTRY_ENTRIES) {
    return err({
      code: "too-many-entries",
      maximum: MAX_TOOL_REGISTRY_ENTRIES,
      attempted: entries.length,
    });
  }

  const byName = new Map<string, ToolRegistryEntry>();
  const byCapabilityId = new Map<CapabilityId, ToolRegistryEntry>();

  for (const entry of entries) {
    const { manifest } = entry;
    const identityResult = validateToolIdentity(manifest.identity);
    if (!identityResult.ok) {
      return err({ code: "invalid-identity", reason: identityResult.error });
    }
    if (!isEffectClass(manifest.effect)) {
      return err({ code: "invalid-descriptor", reason: "invalid-effect" });
    }

    const existingByName = byName.get(manifest.name);
    if (existingByName !== undefined) {
      if (existingByName.manifest.source === "builtin" && manifest.source !== "builtin") {
        return err({
          code: "builtin-shadowed",
          name: manifest.name,
          source: manifest.source,
        });
      }
      return err({ code: "duplicate-name", name: manifest.name });
    }
    if (byCapabilityId.has(manifest.capabilityId)) {
      return err({
        code: "duplicate-capability-id",
        capabilityId: manifest.capabilityId,
      });
    }

    byName.set(manifest.name, entry);
    byCapabilityId.set(manifest.capabilityId, entry);
  }

  const catalog = createToolCatalog(
    generation,
    entries.map((entry) => entry.descriptor),
  );

  const frozen = Object.freeze([...entries]) as readonly ToolRegistryEntry[];

  return ok({
    schemaVersion: TOOL_REGISTRY_SCHEMA_VERSION,
    generation,
    entries: frozen,
    catalog,
    resolveByName(name: string): ToolRegistryEntry | null {
      return byName.get(name) ?? null;
    },
    resolveByCapabilityId(id: CapabilityId): ToolRegistryEntry | null {
      return byCapabilityId.get(id) ?? null;
    },
    resolveByIdentity(identity: ToolIdentity): ToolRegistryEntry | null {
      const encoded = encodeToolIdentity(identity);
      if (!encoded.ok) {
        return null;
      }
      return byCapabilityId.get(encoded.value) ?? null;
    },
  });
}

/** Convenience defaults for tests and builtin registration helpers. */
export function defaultToolLimits(overrides: Partial<ToolLimits> = {}): ToolLimits {
  return {
    maxInputBytes: overrides.maxInputBytes ?? DEFAULT_TOOL_MAX_INPUT_BYTES,
    maxOutputBytes: overrides.maxOutputBytes ?? DEFAULT_TOOL_MAX_OUTPUT_BYTES,
    defaultTimeoutMs: overrides.defaultTimeoutMs ?? null,
  };
}

export function defaultConcurrencyContract(
  overrides: Partial<ConcurrencyContract> = {},
): ConcurrencyContract {
  return {
    maxGlobal: overrides.maxGlobal ?? null,
    maxPerWorkspace: overrides.maxPerWorkspace ?? null,
  };
}

export function defaultProjectionContract(
  overrides: Partial<ProjectionContract> = {},
): ProjectionContract {
  return {
    modelMaxBytes: overrides.modelMaxBytes ?? 8 * 1024,
    redactSensitive: overrides.redactSensitive ?? true,
  };
}
