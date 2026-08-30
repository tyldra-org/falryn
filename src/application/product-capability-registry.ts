/** Product adapters that publish executable tools into the shared registry. */

import { createHash } from "node:crypto";
import { z } from "zod";

import {
  type CapabilityFamily,
  type CapabilityRegistry,
  type CapabilityRegistryEntry,
  type ConfigurationGeneration,
  createCapabilityRegistry,
  createCapabilityRegistryEntry,
  defaultCapabilityOperationalState,
  type ToolCapabilityKind,
  type ToolRegistry,
  type ToolRegistryEntry,
} from "../domain/index.ts";

function digestSchema(schema: z.ZodType<Readonly<Record<string, unknown>>>): string {
  const encoded = JSON.stringify(z.toJSONSchema(schema));
  return `sha-256:${createHash("sha256").update(encoded).digest("hex")}`;
}

function filesystemFamily(name: string): CapabilityFamily {
  if (
    name.startsWith("write_") ||
    name.startsWith("mutate_") ||
    name.startsWith("apply_") ||
    name.startsWith("preview_patch") ||
    name === "scratch_write" ||
    name === "scratch_discard"
  ) {
    return "edit";
  }
  if (name === "discover_files" || name === "search_text") return "search";
  return "read";
}

/** Stable family mapping for the current executable tool vocabulary. */
export function capabilityFamilyForTool(kind: ToolCapabilityKind, name: string): CapabilityFamily {
  switch (kind) {
    case "filesystem":
      return filesystemFamily(name);
    case "search":
      return "search";
    case "process":
    case "git":
    case "dap":
      return "run";
    case "network":
    case "browser":
      return "browser";
    case "computer-use":
      return "computer";
    case "lsp":
      return /(?:rename|format|code_action|workspace_edit)/u.test(name) ? "edit" : "search";
    case "mcp":
    case "plugin":
    case "composite":
      return "capability";
    case "other":
      if (name === "memory_recall") return "read";
      if (name === "memory_admit") return "edit";
      return "capability";
  }
}

function maximumConcurrency(entry: ToolRegistryEntry): number | null {
  const declared = [
    entry.manifest.concurrency.maxGlobal,
    entry.manifest.concurrency.maxPerWorkspace,
  ].filter((value): value is number => value !== null);
  return declared.length === 0 ? null : Math.min(...declared);
}

export function capabilityEntryFromTool(entry: ToolRegistryEntry): CapabilityRegistryEntry {
  const platforms = entry.manifest.platforms;
  const created = createCapabilityRegistryEntry(
    {
      namespace: entry.manifest.namespace,
      name: entry.manifest.name,
      version: entry.manifest.version,
      source: entry.manifest.source,
      kind: entry.manifest.source === "mcp" ? "mcp-tool" : "tool",
      title: entry.manifest.title,
      summary: entry.manifest.description,
      family: capabilityFamilyForTool(entry.manifest.capabilityKind, entry.manifest.name),
      effect: entry.manifest.effect,
      provenance: {
        sourceId: `${entry.manifest.source}:${entry.manifest.namespace}`,
        sourceVersion: String(entry.manifest.version),
      },
      compatibility: {
        os: [...new Set(platforms.flatMap((platform) => platform.os))],
        arch: [...new Set(platforms.flatMap((platform) => platform.arch))],
        dependencies: [],
      },
      limits: {
        maxInputBytes: entry.manifest.limits.maxInputBytes,
        maxOutputBytes: entry.manifest.limits.maxOutputBytes,
        defaultTimeoutMs: entry.manifest.limits.defaultTimeoutMs,
        maxConcurrency: maximumConcurrency(entry),
      },
      routing: {
        costClass: "unknown",
        latencyClass: "unknown",
      },
      state: {
        availability: "available",
        availabilityReason: null,
        health: "healthy",
        healthReason: null,
        executable: true,
        executionReason: null,
        operational: defaultCapabilityOperationalState(),
      },
      schemas: {
        inputDigest: digestSchema(entry.manifest.inputSchema),
        outputDigest: digestSchema(entry.manifest.outputSchema),
      },
    },
    { capabilityId: entry.manifest.capabilityId },
  );
  if (!created.ok) {
    throw new Error(`tool capability publication failed: ${created.error.code}`);
  }
  return created.value;
}

/** Publish executable tools and independent non-tool contributions together. */
export function createProductCapabilityRegistry(
  generation: ConfigurationGeneration,
  tools: ToolRegistry,
  contributions: readonly CapabilityRegistryEntry[] = [],
): CapabilityRegistry {
  if (tools.generation !== generation) {
    throw new Error("tool and capability catalog generations do not match");
  }
  const created = createCapabilityRegistry(generation, [
    ...tools.entries.map(capabilityEntryFromTool),
    ...contributions,
  ]);
  if (!created.ok) {
    throw new Error(`product capability registry failed: ${created.error.code}`);
  }
  return created.value;
}
