import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  bindToolProposals,
  capabilityId,
  configurationGeneration,
  createToolRegistry,
  createToolRegistryEntry,
  defaultConcurrencyContract,
  defaultProjectionContract,
  defaultToolLimits,
  describeToolValidateError,
  invocationId,
  isToolValidateErrorCode,
  normalizeToolPathArgument,
  type ToolManifestDocument,
  toBoundToolInvocation,
  validateAndNormalizeInvocations,
} from "./index.ts";

const generation = configurationGeneration.from(0);

const pathSchema = z.object({ path: z.string().min(1) }).strict() as z.ZodType<
  Readonly<Record<string, unknown>>
>;
const pathOutputSchema = z.object({ content: z.string() }).strict() as z.ZodType<
  Readonly<Record<string, unknown>>
>;
const pathsSchema = z.object({ paths: z.array(z.string().min(1)) }).strict() as z.ZodType<
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
    limits: defaultToolLimits({ maxInputBytes: 1024 }),
    concurrency: defaultConcurrencyContract(),
    resultProjection: defaultProjectionContract(),
    ...overrides,
  };
}

function buildRegistry(document: ToolManifestDocument = readFileDocument()) {
  const entry = createToolRegistryEntry(document, {
    inputSchema: pathSchema,
    outputSchema: pathOutputSchema,
  });
  expect(entry.ok).toBe(true);
  if (!entry.ok) {
    throw new Error("expected registry entry");
  }
  const registry = createToolRegistry(generation, [entry.value]);
  expect(registry.ok).toBe(true);
  if (!registry.ok) {
    throw new Error("expected registry");
  }
  return registry.value;
}

describe("validateAndNormalizeInvocations", () => {
  test("produces dispatch-ready invocations from valid proposals", () => {
    const registry = buildRegistry();
    const result = validateAndNormalizeInvocations({
      registry,
      proposals: [{ toolCallId: "call-1", name: "read_file", arguments: { path: "src/./a.ts" } }],
      maxQueued: 8,
      nextInvocationId: () => invocationId.from("inv-1"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value).toHaveLength(1);
    const ready = result.value[0];
    expect(ready?.invocationId).toBe(invocationId.from("inv-1"));
    expect(ready?.entry.manifest.capabilityId).toBe(
      capabilityId.from("builtin:workspace/read_file@1"),
    );
    expect(ready?.input).toEqual({ path: "src/a.ts" });
    expect(ready?.conflictKeys).toEqual([]);
  });

  test("projects onto the #44 bind shape for the tool-call loop", () => {
    const registry = buildRegistry();
    const result = validateAndNormalizeInvocations({
      registry,
      proposals: [{ toolCallId: "call-1", name: "read_file", arguments: { path: "a.ts" } }],
      maxQueued: 8,
      nextInvocationId: () => invocationId.from("inv-1"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const ready = result.value[0];
    expect(ready).toBeDefined();
    if (ready === undefined) {
      return;
    }
    const bound = toBoundToolInvocation(ready);
    expect(bound.descriptor.name).toBe("read_file");
    expect(bound.input).toEqual({ path: "a.ts" });

    const viaCatalog = bindToolProposals({
      catalog: registry.catalog,
      proposals: [{ toolCallId: "call-1", name: "read_file", arguments: { path: "a.ts" } }],
      maxQueued: 8,
      nextInvocationId: () => invocationId.from("inv-1"),
    });
    expect(viaCatalog.ok).toBe(true);
    if (!viaCatalog.ok) {
      return;
    }
    const catalogBound = viaCatalog.value[0];
    expect(catalogBound).toBeDefined();
    if (catalogBound === undefined) {
      return;
    }
    expect(bound.descriptor.id).toBe(catalogBound.descriptor.id);
    expect(bound.input).toEqual(catalogBound.input);
  });

  test("rejects unknown tools with no effect", () => {
    const registry = buildRegistry();
    const result = validateAndNormalizeInvocations({
      registry,
      proposals: [{ toolCallId: "call-1", name: "missing", arguments: {} }],
      maxQueued: 8,
      nextInvocationId: () => invocationId.from("inv-1"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toEqual({
      code: "unknown-tool",
      toolCallId: "call-1",
      name: "missing",
    });
  });

  test("rejects malformed schema input", () => {
    const registry = buildRegistry();
    const result = validateAndNormalizeInvocations({
      registry,
      proposals: [{ toolCallId: "call-1", name: "read_file", arguments: { path: 1 } }],
      maxQueued: 8,
      nextInvocationId: () => invocationId.from("inv-1"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("malformed-input");
  });

  test("rejects non-object arguments", () => {
    const registry = buildRegistry();
    for (const [argumentsValue, reason] of [
      [null, "null"],
      [[1], "array"],
      ["x", "not-object"],
    ] as const) {
      const result = validateAndNormalizeInvocations({
        registry,
        proposals: [{ toolCallId: "call-1", name: "read_file", arguments: argumentsValue }],
        maxQueued: 8,
        nextInvocationId: () => invocationId.from("inv-1"),
      });
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.error).toEqual({
        code: "malformed-arguments",
        toolCallId: "call-1",
        name: "read_file",
        reason,
      });
    }
  });

  test("rejects duplicate and invalid tool call ids", () => {
    const registry = buildRegistry();
    const duplicate = validateAndNormalizeInvocations({
      registry,
      proposals: [
        { toolCallId: "call-1", name: "read_file", arguments: { path: "a.ts" } },
        { toolCallId: "call-1", name: "read_file", arguments: { path: "b.ts" } },
      ],
      maxQueued: 8,
      nextInvocationId: () => invocationId.from("inv-1"),
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.error.code).toBe("duplicate-tool-call-id");
    }

    const invalid = validateAndNormalizeInvocations({
      registry,
      proposals: [{ toolCallId: "bad id", name: "read_file", arguments: { path: "a.ts" } }],
      maxQueued: 8,
      nextInvocationId: () => invocationId.from("inv-1"),
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.code).toBe("invalid-tool-call-id");
    }
  });

  test("rejects queue bound overflow", () => {
    const registry = buildRegistry();
    const result = validateAndNormalizeInvocations({
      registry,
      proposals: [
        { toolCallId: "a", name: "read_file", arguments: { path: "a.ts" } },
        { toolCallId: "b", name: "read_file", arguments: { path: "b.ts" } },
      ],
      maxQueued: 1,
      nextInvocationId: () => invocationId.from("inv-1"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        code: "queue-bound-exceeded",
        maximum: 1,
        attempted: 2,
      });
    }
  });

  test("rejects unsupported version", () => {
    const registry = buildRegistry();
    const result = validateAndNormalizeInvocations({
      registry,
      proposals: [
        { toolCallId: "call-1", name: "read_file", arguments: { path: "a.ts" }, version: 9 },
      ],
      maxQueued: 8,
      nextInvocationId: () => invocationId.from("inv-1"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        code: "unsupported-version",
        toolCallId: "call-1",
        name: "read_file",
        requested: 9,
        available: 1,
      });
    }
  });

  test("rejects unsupported platform and requires host when constrained", () => {
    const registry = buildRegistry(
      readFileDocument({
        platforms: [{ os: ["linux"], arch: ["x64"] }],
      }),
    );

    const missingHost = validateAndNormalizeInvocations({
      registry,
      proposals: [{ toolCallId: "call-1", name: "read_file", arguments: { path: "a.ts" } }],
      maxQueued: 8,
      nextInvocationId: () => invocationId.from("inv-1"),
    });
    expect(missingHost.ok).toBe(false);
    if (!missingHost.ok) {
      expect(missingHost.error.code).toBe("host-platform-required");
    }

    const wrongHost = validateAndNormalizeInvocations({
      registry,
      proposals: [{ toolCallId: "call-1", name: "read_file", arguments: { path: "a.ts" } }],
      maxQueued: 8,
      nextInvocationId: () => invocationId.from("inv-1"),
      host: { os: "darwin", arch: "arm64" },
    });
    expect(wrongHost.ok).toBe(false);
    if (!wrongHost.ok) {
      expect(wrongHost.error).toEqual({
        code: "unsupported-platform",
        toolCallId: "call-1",
        name: "read_file",
        os: "darwin",
        arch: "arm64",
      });
    }

    const okHost = validateAndNormalizeInvocations({
      registry,
      proposals: [{ toolCallId: "call-1", name: "read_file", arguments: { path: "a.ts" } }],
      maxQueued: 8,
      nextInvocationId: () => invocationId.from("inv-1"),
      host: { os: "linux", arch: "x64" },
    });
    expect(okHost.ok).toBe(true);
  });

  test("rejects input that exceeds manifest byte limits", () => {
    const registry = buildRegistry(
      readFileDocument({ limits: defaultToolLimits({ maxInputBytes: 32 }) }),
    );
    const result = validateAndNormalizeInvocations({
      registry,
      proposals: [
        {
          toolCallId: "call-1",
          name: "read_file",
          arguments: { path: "x".repeat(64) },
        },
      ],
      maxQueued: 8,
      nextInvocationId: () => invocationId.from("inv-1"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("input-too-large");
    }
  });

  test("rejects path arguments containing NUL", () => {
    const registry = buildRegistry();
    const result = validateAndNormalizeInvocations({
      registry,
      proposals: [{ toolCallId: "call-1", name: "read_file", arguments: { path: "a\0.ts" } }],
      maxQueued: 8,
      nextInvocationId: () => invocationId.from("inv-1"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        code: "invalid-path-argument",
        toolCallId: "call-1",
        name: "read_file",
        field: "path",
      });
    }
  });

  test("normalizes paths arrays", () => {
    const entry = createToolRegistryEntry(readFileDocument({ name: "list_paths" }), {
      inputSchema: pathsSchema,
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
    const result = validateAndNormalizeInvocations({
      registry: registry.value,
      proposals: [
        {
          toolCallId: "call-1",
          name: "list_paths",
          arguments: { paths: ["src\\\\a.ts", "./b.ts"] },
        },
      ],
      maxQueued: 8,
      nextInvocationId: () => invocationId.from("inv-1"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value[0]?.input).toEqual({ paths: ["src/a.ts", "b.ts"] });
  });

  test("covers every validate error code in the type guard", () => {
    const codes = [
      "unknown-tool",
      "malformed-input",
      "malformed-arguments",
      "duplicate-tool-call-id",
      "invalid-tool-call-id",
      "queue-bound-exceeded",
      "unsupported-platform",
      "unsupported-version",
      "input-too-large",
      "invalid-path-argument",
      "host-platform-required",
    ] as const;
    for (const code of codes) {
      expect(isToolValidateErrorCode(code)).toBe(true);
    }
    expect(isToolValidateErrorCode("nope")).toBe(false);
    expect(
      describeToolValidateError({
        code: "unknown-tool",
        toolCallId: "c",
        name: "t",
      }),
    ).toBe("unknown-tool");
  });
});

describe("normalizeToolPathArgument", () => {
  test("collapses separators and dots", () => {
    expect(normalizeToolPathArgument("src\\\\./a/../b.ts")).toBe("src/a/../b.ts");
    expect(normalizeToolPathArgument("/usr/./local")).toBe("/usr/local");
    expect(normalizeToolPathArgument("C:\\\\Temp\\\\.")).toBe("C:/Temp");
  });

  test("rejects NUL", () => {
    expect(normalizeToolPathArgument("a\0b")).toBeNull();
  });
});
