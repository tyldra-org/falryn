import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  bindToolProposals,
  capabilityId,
  configurationGeneration,
  createToolRegistry,
  createToolRegistryEntry,
  decodeToolIdentity,
  defaultConcurrencyContract,
  defaultProjectionContract,
  defaultToolLimits,
  encodeToolIdentity,
  invocationId,
  parseToolManifestDocument,
  type ToolManifestDocument,
  validateToolIdentity,
} from "./index.ts";

const generation = configurationGeneration.from(0);

const emptyObjectSchema = z.object({}).strict() as z.ZodType<Readonly<Record<string, unknown>>>;
const pathSchema = z.object({ path: z.string().min(1) }).strict() as z.ZodType<
  Readonly<Record<string, unknown>>
>;
const pathOutputSchema = z.object({ content: z.string() }).strict() as z.ZodType<
  Readonly<Record<string, unknown>>
>;

function readFileDocument(overrides: Partial<ToolManifestDocument> = {}): ToolManifestDocument {
  return {
    namespace: "workspace",
    name: "read_file",
    version: 1,
    source: "builtin",
    title: "Read file",
    description: "Read a workspace file",
    effect: "observation",
    capabilityKind: "filesystem",
    platforms: [],
    limits: defaultToolLimits(),
    concurrency: defaultConcurrencyContract({ maxPerWorkspace: 8 }),
    resultProjection: defaultProjectionContract(),
    ...overrides,
  };
}

function writeFileDocument(): ToolManifestDocument {
  return readFileDocument({
    name: "write_file",
    title: "Write file",
    description: "Write a workspace file",
    effect: "mutation",
  });
}

describe("tool identity", () => {
  test("encodes and decodes a stable capability id", () => {
    const identity = {
      namespace: "workspace",
      name: "read_file",
      version: 1,
      source: "builtin" as const,
    };
    const encoded = encodeToolIdentity(identity);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) {
      return;
    }
    expect(encoded.value).toBe(capabilityId.from("builtin:workspace/read_file@1"));
    const decoded = decodeToolIdentity(encoded.value);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) {
      return;
    }
    expect(decoded.value).toEqual(identity);
  });

  test("rejects illegal identity segments", () => {
    const result = validateToolIdentity({
      namespace: "Work Space",
      name: "read_file",
      version: 1,
      source: "builtin",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toEqual({
      code: "identifier-illegal-character",
      field: "namespace",
    });
  });
});

describe("tool manifest document boundary", () => {
  test("parses a valid document", () => {
    const parsed = parseToolManifestDocument(readFileDocument());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value.name).toBe("read_file");
    expect(parsed.value.effect).toBe("observation");
  });

  test("rejects unknown fields and malformed values without echoing them", () => {
    const parsed = parseToolManifestDocument({
      ...readFileDocument(),
      effect: "explode",
      secret: "do-not-leak",
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    const serialized = JSON.stringify(parsed.error);
    expect(serialized).not.toContain("do-not-leak");
    expect(serialized).not.toContain("explode");
    expect(parsed.error.some((issue) => issue.path === "effect" || issue.code.length > 0)).toBe(
      true,
    );
  });

  test("rejects empty title at the document boundary", () => {
    const parsed = parseToolManifestDocument(readFileDocument({ title: "" }));
    expect(parsed.ok).toBe(false);
  });
});

describe("tool registry", () => {
  test("registers manifests and resolves by name, identity, and capability id", () => {
    const readEntry = createToolRegistryEntry(readFileDocument(), {
      inputSchema: pathSchema,
      outputSchema: pathOutputSchema,
    });
    expect(readEntry.ok).toBe(true);
    if (!readEntry.ok) {
      return;
    }

    const writeEntry = createToolRegistryEntry(writeFileDocument(), {
      inputSchema: pathSchema,
      outputSchema: emptyObjectSchema,
    });
    expect(writeEntry.ok).toBe(true);
    if (!writeEntry.ok) {
      return;
    }

    const registry = createToolRegistry(generation, [readEntry.value, writeEntry.value]);
    expect(registry.ok).toBe(true);
    if (!registry.ok) {
      return;
    }

    expect(registry.value.entries).toHaveLength(2);
    expect(registry.value.resolveByName("read_file")?.manifest.title).toBe("Read file");
    expect(
      registry.value.resolveByCapabilityId(readEntry.value.manifest.capabilityId)?.manifest.name,
    ).toBe("read_file");
    expect(
      registry.value.resolveByIdentity({
        namespace: "workspace",
        name: "write_file",
        version: 1,
        source: "builtin",
      })?.manifest.effect,
    ).toBe("mutation");
  });

  test("feeds the tool-pipeline catalog bind path", () => {
    const entry = createToolRegistryEntry(readFileDocument(), {
      inputSchema: pathSchema,
      outputSchema: pathOutputSchema,
    });
    expect(entry.ok).toBe(true);
    if (!entry.ok) {
      return;
    }
    const registry = createToolRegistry(generation, [entry.value]);
    expect(registry.ok).toBe(true);
    if (!registry.ok) {
      return;
    }

    const bound = bindToolProposals({
      catalog: registry.value.catalog,
      proposals: [{ toolCallId: "call-1", name: "read_file", arguments: { path: "a.ts" } }],
      maxQueued: 8,
      nextInvocationId: () => invocationId.from("inv-1"),
    });
    expect(bound.ok).toBe(true);
    if (!bound.ok) {
      return;
    }
    expect(bound.value[0]?.descriptor.id).toBe(capabilityId.from("builtin:workspace/read_file@1"));
    expect(bound.value[0]?.input).toEqual({ path: "a.ts" });
  });

  test("rejects duplicate catalog names", () => {
    const first = createToolRegistryEntry(readFileDocument(), {
      inputSchema: pathSchema,
      outputSchema: pathOutputSchema,
    });
    const second = createToolRegistryEntry(readFileDocument({ namespace: "other", version: 2 }), {
      inputSchema: pathSchema,
      outputSchema: pathOutputSchema,
    });
    expect(first.ok && second.ok).toBe(true);
    if (!(first.ok && second.ok)) {
      return;
    }
    const registry = createToolRegistry(generation, [first.value, second.value]);
    expect(registry.ok).toBe(false);
    if (registry.ok) {
      return;
    }
    expect(registry.error).toEqual({ code: "duplicate-name", name: "read_file" });
  });

  test("rejects non-builtin shadowing of a builtin name", () => {
    const builtin = createToolRegistryEntry(readFileDocument(), {
      inputSchema: pathSchema,
      outputSchema: pathOutputSchema,
    });
    const plugin = createToolRegistryEntry(
      readFileDocument({ source: "plugin", namespace: "ext" }),
      {
        inputSchema: pathSchema,
        outputSchema: pathOutputSchema,
      },
    );
    expect(builtin.ok && plugin.ok).toBe(true);
    if (!(builtin.ok && plugin.ok)) {
      return;
    }
    const registry = createToolRegistry(generation, [builtin.value, plugin.value]);
    expect(registry.ok).toBe(false);
    if (registry.ok) {
      return;
    }
    expect(registry.error).toEqual({
      code: "builtin-shadowed",
      name: "read_file",
      source: "plugin",
    });
  });

  test("rejects duplicate capability ids", () => {
    const first = createToolRegistryEntry(readFileDocument(), {
      inputSchema: pathSchema,
      outputSchema: pathOutputSchema,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const clone: typeof first.value = {
      ...first.value,
      manifest: { ...first.value.manifest, name: "read_file_alias" },
      descriptor: { ...first.value.descriptor, name: "read_file_alias" },
    };
    const registry = createToolRegistry(generation, [first.value, clone]);
    expect(registry.ok).toBe(false);
    if (registry.ok) {
      return;
    }
    expect(registry.error.code).toBe("duplicate-capability-id");
  });

  test("covers every effect class in registry entries", () => {
    const effects = ["observation", "mutation", "external", "interactive"] as const;
    const entries = [];
    for (const [index, effect] of effects.entries()) {
      const created = createToolRegistryEntry(
        readFileDocument({
          name: `tool_${effect}`,
          title: effect,
          effect,
          capabilityKind: effect === "interactive" ? "browser" : "other",
        }),
        {
          inputSchema: emptyObjectSchema,
          outputSchema: emptyObjectSchema,
        },
      );
      expect(created.ok).toBe(true);
      if (!created.ok) {
        return;
      }
      expect(created.value.manifest.effect).toBe(effect);
      expect(created.value.manifest.version).toBe(1);
      expect(index).toBeGreaterThanOrEqual(0);
      entries.push(created.value);
    }
    const registry = createToolRegistry(generation, entries);
    expect(registry.ok).toBe(true);
    if (!registry.ok) {
      return;
    }
    expect(registry.value.entries.map((entry) => entry.manifest.effect)).toEqual([...effects]);
  });
});
