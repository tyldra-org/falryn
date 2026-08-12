import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  bindToolProposals,
  capabilityId,
  configurationGeneration,
  createToolCatalog,
  effectOfToolOutcome,
  foldToolEffects,
  invocationId,
  type ToolDescriptor,
  type ToolProposal,
} from "./index.ts";

const generation = configurationGeneration.from(0);

const pathSchema = z.object({ path: z.string().min(1) }).strict() as z.ZodType<
  Readonly<Record<string, unknown>>
>;

function readFileDescriptor(): ToolDescriptor {
  return {
    id: capabilityId.from("workspace.read"),
    version: 1,
    name: "read_file",
    effect: "observation",
    inputSchema: pathSchema,
  };
}

function writeFileDescriptor(): ToolDescriptor {
  return {
    id: capabilityId.from("workspace.write"),
    version: 1,
    name: "write_file",
    effect: "mutation",
    inputSchema: z.object({ path: z.string().min(1), content: z.string() }).strict() as z.ZodType<
      Readonly<Record<string, unknown>>
    >,
  };
}

describe("tool pipeline binding", () => {
  test("binds valid proposals against the catalog", () => {
    const catalog = createToolCatalog(generation, [readFileDescriptor()]);
    const proposals: ToolProposal[] = [
      { toolCallId: "call-1", name: "read_file", arguments: { path: "a.ts" } },
    ];

    const bound = bindToolProposals({
      catalog,
      proposals,
      maxQueued: 8,
      nextInvocationId: () => invocationId.from("inv-1"),
    });

    expect(bound.ok).toBe(true);
    if (!bound.ok) {
      return;
    }
    expect(bound.value).toHaveLength(1);
    expect(bound.value[0]?.descriptor.name).toBe("read_file");
    expect(bound.value[0]?.input).toEqual({ path: "a.ts" });
  });

  test("rejects unknown tools with no effect", () => {
    const catalog = createToolCatalog(generation, [readFileDescriptor()]);
    const bound = bindToolProposals({
      catalog,
      proposals: [{ toolCallId: "call-1", name: "missing", arguments: {} }],
      maxQueued: 8,
      nextInvocationId: () => invocationId.from("inv-1"),
    });

    expect(bound.ok).toBe(false);
    if (bound.ok) {
      return;
    }
    expect(bound.error).toEqual({
      code: "unknown-tool",
      toolCallId: "call-1",
      name: "missing",
    });
  });

  test("rejects malformed input without executing", () => {
    const catalog = createToolCatalog(generation, [readFileDescriptor()]);
    const bound = bindToolProposals({
      catalog,
      proposals: [{ toolCallId: "call-1", name: "read_file", arguments: { path: 1 } }],
      maxQueued: 8,
      nextInvocationId: () => invocationId.from("inv-1"),
    });

    expect(bound.ok).toBe(false);
    if (bound.ok) {
      return;
    }
    expect(bound.error.code).toBe("malformed-input");
  });

  test("fails closed when the proposal queue bound is exceeded", () => {
    const catalog = createToolCatalog(generation, [readFileDescriptor()]);
    const bound = bindToolProposals({
      catalog,
      proposals: [
        { toolCallId: "a", name: "read_file", arguments: { path: "a.ts" } },
        { toolCallId: "b", name: "read_file", arguments: { path: "b.ts" } },
      ],
      maxQueued: 1,
      nextInvocationId: (proposal) => invocationId.from(`inv-${proposal.toolCallId}`),
    });

    expect(bound.ok).toBe(false);
    if (bound.ok) {
      return;
    }
    expect(bound.error).toEqual({
      code: "queue-bound-exceeded",
      maximum: 1,
      attempted: 2,
    });
  });

  test("rejects duplicate tool call ids", () => {
    const catalog = createToolCatalog(generation, [readFileDescriptor()]);
    const bound = bindToolProposals({
      catalog,
      proposals: [
        { toolCallId: "dup", name: "read_file", arguments: { path: "a.ts" } },
        { toolCallId: "dup", name: "read_file", arguments: { path: "b.ts" } },
      ],
      maxQueued: 8,
      nextInvocationId: () => invocationId.from("inv-1"),
    });

    expect(bound.ok).toBe(false);
    if (bound.ok) {
      return;
    }
    expect(bound.error.code).toBe("duplicate-tool-call-id");
  });

  test("classifies effect classes on descriptors", () => {
    const catalog = createToolCatalog(generation, [readFileDescriptor(), writeFileDescriptor()]);
    expect(catalog.resolve("read_file")?.effect).toBe("observation");
    expect(catalog.resolve("write_file")?.effect).toBe("mutation");
  });

  test("folds effect certainty without downgrading uncertainty", () => {
    expect(foldToolEffects(["none", "completed", "partial"])).toBe("partial");
    expect(foldToolEffects(["partial", "uncertain"])).toBe("uncertain");
    expect(
      effectOfToolOutcome({
        status: "denied",
        reason: "policy",
        effect: "none",
      }),
    ).toBe("none");
  });
});
