/**
 * Bounded product-tool disclosure for one provider attempt (#786).
 *
 * Registration and model visibility are deliberately separate. The provider
 * receives a small, deterministic subset of closed schemas plus the two
 * explicitly bounded process escape hatches. Everything else remains visible
 * in the receipt as omitted; it is never silently executable.
 */

import { createHash } from "node:crypto";
import { z } from "zod";

import type {
  CapabilityId,
  ConfigurationGeneration,
  EffectClass,
  PromptToolInput,
  ToolCapabilityKind,
  ToolRegistry,
} from "../domain/index.ts";
import type { ModelToolDefinition } from "../providers/index.ts";

export const PRODUCT_TOOL_DISCLOSURE_SCHEMA_VERSION = 1;
export const MAX_DISCLOSED_PRODUCT_TOOLS = 16;

export const MODEL_CAPABILITY_FAMILIES = [
  "search",
  "read",
  "edit",
  "run",
  "browser",
  "computer",
  "delegate",
  "capability",
] as const;

export type ModelCapabilityFamily = (typeof MODEL_CAPABILITY_FAMILIES)[number];

export type CapabilityFamilyAvailability = {
  readonly family: ModelCapabilityFamily;
  readonly available: boolean;
  readonly reason: string | null;
};

export type DisclosedProductTool = {
  readonly name: string;
  readonly capabilityId: CapabilityId;
  readonly version: number;
  readonly effect: EffectClass;
  readonly capabilityKind: ToolCapabilityKind;
  readonly schemaDigest: string;
  readonly schemaBytes: number;
  readonly schemaTokensEstimated: number;
};

export type CapabilityDisclosureReceipt = {
  readonly schemaVersion: typeof PRODUCT_TOOL_DISCLOSURE_SCHEMA_VERSION;
  readonly catalogGeneration: ConfigurationGeneration;
  readonly families: readonly CapabilityFamilyAvailability[];
  readonly disclosed: readonly DisclosedProductTool[];
  readonly omitted: readonly { readonly name: string; readonly reason: string }[];
  readonly schemaBytes: number;
  readonly schemaTokensEstimated: number;
  readonly discoveryHandle: string;
};

export type ProductToolDisclosure = {
  readonly promptTools: readonly PromptToolInput[];
  readonly modelTools: readonly ModelToolDefinition[];
  readonly receipt: CapabilityDisclosureReceipt;
};

const PREFERRED_TOOL_ORDER = [
  "read_file",
  "list_dir",
  "stat_path",
  "read_compact_document",
  "write_files",
  "preview_patch",
  "apply_patch",
  "run_process",
  "run_shell",
  "git_status",
  "git_diff",
  "git_log",
  "lsp_hover",
  "lsp_definition",
  "lsp_references",
  "lsp_diagnostics",
] as const;

const RAW_PROTOCOL_ESCAPES = new Set(["run_process", "run_shell"]);
const encoder = new TextEncoder();

export function measureProductToolSchema(schema: Readonly<Record<string, unknown>>) {
  const encoded = JSON.stringify(schema);
  const bytes = encoder.encode(encoded).byteLength;
  return {
    digest: `sha-256:${createHash("sha256").update(encoded).digest("hex")}`,
    bytes,
    tokensEstimated: Math.ceil(bytes / 4),
  };
}

function jsonSchemaFor(
  schema: z.ZodType<Readonly<Record<string, unknown>>>,
): Readonly<Record<string, unknown>> {
  return z.toJSONSchema(schema) as Readonly<Record<string, unknown>>;
}

function isClosedSchema(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isClosedSchema);
  }
  const schema = value as Readonly<Record<string, unknown>>;
  for (const union of [schema.anyOf, schema.oneOf, schema.allOf]) {
    if (Array.isArray(union) && !union.every(isClosedSchema)) {
      return false;
    }
  }
  if (schema.type === "object") {
    if (schema.additionalProperties !== false) {
      return false;
    }
    if (typeof schema.properties === "object" && schema.properties !== null) {
      for (const property of Object.values(schema.properties)) {
        if (!isClosedSchema(property)) {
          return false;
        }
      }
    }
  }
  if (schema.type === "array" && schema.items !== undefined && !isClosedSchema(schema.items)) {
    return false;
  }
  if (typeof schema.$defs === "object" && schema.$defs !== null) {
    for (const definition of Object.values(schema.$defs)) {
      if (!isClosedSchema(definition)) {
        return false;
      }
    }
  }
  return true;
}

function familyAvailability(registry: ToolRegistry): readonly CapabilityFamilyAvailability[] {
  const kinds = new Set(registry.entries.map((entry) => entry.manifest.capabilityKind));
  const available = (family: ModelCapabilityFamily): boolean => {
    switch (family) {
      case "search":
        return kinds.has("search") || kinds.has("lsp");
      case "read":
      case "edit":
        return kinds.has("filesystem");
      case "run":
        return kinds.has("process") || kinds.has("git");
      case "browser":
        return kinds.has("browser") || kinds.has("network");
      case "computer":
        return kinds.has("computer-use");
      case "delegate":
        return false;
      case "capability":
        return true;
    }
  };
  return MODEL_CAPABILITY_FAMILIES.map((family) => ({
    family,
    available: available(family),
    reason: available(family) ? null : "no executable descriptor in this catalog generation",
  }));
}

/**
 * Select the current coding baseline. Task-aware opportunity planning expands
 * this in #193; #786 keeps the first live attempt bounded and inspectable.
 */
export function discloseProductTools(
  registry: ToolRegistry,
  maximum = MAX_DISCLOSED_PRODUCT_TOOLS,
): ProductToolDisclosure {
  const selected = [];
  const omitted: { name: string; reason: string }[] = [];
  const preferred = new Set<string>(PREFERRED_TOOL_ORDER);

  for (const name of PREFERRED_TOOL_ORDER) {
    if (selected.length >= maximum) {
      break;
    }
    const entry = registry.resolveByName(name);
    if (entry === null) {
      continue;
    }
    const parameters = jsonSchemaFor(entry.manifest.inputSchema);
    if (!isClosedSchema(parameters) && !RAW_PROTOCOL_ESCAPES.has(name)) {
      omitted.push({ name, reason: "permissive model-boundary schema" });
      continue;
    }
    selected.push({ entry, parameters });
  }

  for (const entry of registry.entries) {
    if (!preferred.has(entry.manifest.name)) {
      omitted.push({ name: entry.manifest.name, reason: "bounded baseline disclosure" });
    }
  }

  const promptTools: PromptToolInput[] = selected.map(({ entry, parameters }) => ({
    name: entry.manifest.name,
    description: entry.manifest.description,
    parameters,
    required: false,
    available: true,
  }));
  const modelTools: ModelToolDefinition[] = selected.map(({ entry, parameters }) => ({
    name: entry.manifest.name,
    description: entry.manifest.description,
    parameters,
  }));
  const disclosed = selected.map(({ entry, parameters }) => {
    const measured = measureProductToolSchema(parameters);
    return {
      name: entry.manifest.name,
      capabilityId: entry.manifest.capabilityId,
      version: entry.manifest.version,
      effect: entry.manifest.effect,
      capabilityKind: entry.manifest.capabilityKind,
      schemaDigest: measured.digest,
      schemaBytes: measured.bytes,
      schemaTokensEstimated: measured.tokensEstimated,
    };
  });
  return {
    promptTools,
    modelTools,
    receipt: {
      schemaVersion: PRODUCT_TOOL_DISCLOSURE_SCHEMA_VERSION,
      catalogGeneration: registry.generation,
      families: familyAvailability(registry),
      disclosed,
      omitted,
      schemaBytes: disclosed.reduce((total, tool) => total + tool.schemaBytes, 0),
      schemaTokensEstimated: disclosed.reduce(
        (total, tool) => total + tool.schemaTokensEstimated,
        0,
      ),
      discoveryHandle: `tool-catalog:${registry.generation}`,
    },
  };
}
