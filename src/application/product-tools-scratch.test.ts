import { describe, expect, test } from "bun:test";

import {
  capabilityId,
  configurationGeneration,
  instant,
  invocationId,
  ok,
  parseScratchName,
  scratchHandle,
  scratchRevision,
  sessionId,
} from "../domain/index.ts";
import { composeProductScratchTools } from "./product-tools-scratch.ts";
import type { ScratchMetadata, ScratchResourcePort } from "./scratch-resources.ts";

const owner = sessionId.from("session-one");

function metadata(): ScratchMetadata {
  const name = parseScratchName("pr-body.md");
  const revision = scratchRevision(1);
  if (!name.ok || !revision.ok) throw new Error("invalid scratch fixtures");
  return {
    handle: scratchHandle(owner, name.value),
    name: name.value,
    status: "active",
    revision: revision.value,
    digest: `sha-256:${"a".repeat(64)}`,
    mediaType: "text/markdown",
    byteLength: 5,
    createdAt: instant(1),
    updatedAt: instant(1),
  };
}

function scratchPort(): ScratchResourcePort {
  const value = metadata();
  return {
    write: async () => ok(value),
    read: async () => ok({ ...value, text: "draft" }),
    list: () => ok([value]),
    discard: () => ok({ ...value, status: "discarded" }),
    readBytes: async () => ok(new TextEncoder().encode("draft")),
  };
}

describe("product scratch tools", () => {
  test("registers strict bounded operations with accurate effects", () => {
    const tools = composeProductScratchTools({
      generation: configurationGeneration.from(1),
      scratch: scratchPort(),
      sessionId: owner,
    });
    expect(tools.owner).toBe("#848");
    expect(tools.toolNames).toEqual([
      "scratch_write",
      "scratch_read",
      "scratch_list",
      "scratch_discard",
    ]);
    expect(tools.registry.resolveByName("scratch_write")?.manifest.effect).toBe("mutation");
    expect(tools.registry.resolveByName("scratch_read")?.manifest.effect).toBe("observation");
    expect(
      tools.registry.resolveByName("scratch_write")?.manifest.inputSchema.safeParse({
        name: "draft.md",
        text: "draft",
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  test("returns handles and exact content through the shared runner", async () => {
    const tools = composeProductScratchTools({
      generation: configurationGeneration.from(1),
      scratch: scratchPort(),
      sessionId: owner,
    });
    const write = await tools.runner.execute({
      invocationId: invocationId.from("inv-write"),
      toolCallId: "call-write",
      toolName: "scratch_write",
      capabilityId: capabilityId.from("builtin:workspace/scratch_write@1"),
      version: 1,
      effect: "mutation",
      input: { name: "pr-body.md", text: "draft", mediaType: "text/markdown" },
      signal: new AbortController().signal,
    });
    expect(write).toMatchObject({
      status: "completed",
      output: { handle: "scratch://session/session-one/pr-body.md", revision: 1 },
    });

    const read = await tools.runner.execute({
      invocationId: invocationId.from("inv-read"),
      toolCallId: "call-read",
      toolName: "scratch_read",
      capabilityId: capabilityId.from("builtin:workspace/scratch_read@1"),
      version: 1,
      effect: "observation",
      input: { handle: "scratch://session/session-one/pr-body.md" },
      signal: new AbortController().signal,
    });
    expect(read).toMatchObject({ status: "completed", output: { text: "draft" } });
  });
});
