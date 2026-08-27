/**
 * Product workspace tools (#711).
 */

import { describe, expect, test } from "bun:test";

import {
  capabilityId,
  configurationGeneration,
  createInMemoryFileSystem,
  createStubCommandRunner,
  invocationId,
  localPath,
} from "../domain/index.ts";
import { composeProductIndexLifecycle, createEphemeralProductIndexPort } from "./index.ts";
import { mergeProductToolBundles } from "./product-tools-merge.ts";
import { composeProductWorkspaceTools } from "./product-tools-workspace.ts";

const root = localPath("/work/project");

function toolsUnder() {
  const fileSystem = createInMemoryFileSystem({
    nodes: {
      "/work/project": { kind: "directory" },
      "/work/project/hello.ts": { kind: "file", text: "export const n = 1;\n" },
      "/work/project/src": { kind: "directory" },
      "/work/project/src/a.ts": { kind: "file", text: "const token = 1;\n" },
    },
  });
  return composeProductWorkspaceTools({
    generation: configurationGeneration.from(0),
    fileSystem,
    commands: createStubCommandRunner(() => ({
      kind: "exited",
      exitCode: 1,
      stdout: "",
    })),
    workspaceRoot: root,
  });
}

describe("composeProductWorkspaceTools", () => {
  test("registers filesystem, reader, search, and patch tools", async () => {
    const tools = toolsUnder();
    expect(tools.owner).toBe("#711");
    expect(tools.toolNames).toEqual(
      expect.arrayContaining([
        "list_dir",
        "stat_path",
        "read_file",
        "read_compact_document",
        "write_files",
        "mutate_paths",
        "discover_files",
        "search_text",
        "preview_patch",
        "apply_patch",
      ]),
    );
    expect(tools.catalog.resolve("read_file")?.id).toBe(
      capabilityId.from("builtin:workspace/read_file@1"),
    );
    expect(tools.catalog.resolve("shell")).toBeNull();
    expect(
      tools.registry.resolveByName("read_file")?.manifest.inputSchema.safeParse({
        targets: [{ path: "hello.ts", range: { kind: "line", range: { start: 1, end: 1 } } }],
        outputMode: "raw",
      }).success,
    ).toBe(true);
    expect(
      tools.registry.resolveByName("read_file")?.manifest.inputSchema.safeParse({
        path: "hello.ts",
        outputMode: "hush",
      }).success,
    ).toBe(false);
    expect(
      tools.registry.resolveByName("stat_path")?.manifest.inputSchema.safeParse({
        recovery: { manifestId: "loom-1", artifactId: "artifact-1" },
        projection: { kind: "exact" },
      }).success,
    ).toBe(false);

    const read = await tools.runner.execute({
      invocationId: invocationId.from("inv-read"),
      toolCallId: "call-read",
      toolName: "read_file",
      capabilityId: capabilityId.from("builtin:workspace/read_file@1"),
      version: 1,
      effect: "observation",
      input: { path: "hello.ts" },
      signal: new AbortController().signal,
    });
    expect(read.status).toBe("completed");
    if (read.status !== "completed") {
      return;
    }
    expect(JSON.stringify(read.output)).toContain("export const n");

    const listed = await tools.runner.execute({
      invocationId: invocationId.from("inv-list"),
      toolCallId: "call-list",
      toolName: "list_dir",
      capabilityId: capabilityId.from("builtin:workspace/list_dir@1"),
      version: 1,
      effect: "observation",
      input: { path: "." },
      signal: new AbortController().signal,
    });
    expect(listed.status).toBe("completed");

    const searched = await tools.runner.execute({
      invocationId: invocationId.from("inv-search"),
      toolCallId: "call-search",
      toolName: "search_text",
      capabilityId: capabilityId.from("builtin:workspace/search_text@1"),
      version: 1,
      effect: "observation",
      input: { query: "token", path: "src" },
      signal: new AbortController().signal,
    });
    expect(searched.status).toBe("completed");

    const missing = await tools.runner.execute({
      invocationId: invocationId.from("inv-miss"),
      toolCallId: "call-miss",
      toolName: "read_file",
      capabilityId: capabilityId.from("builtin:workspace/read_file@1"),
      version: 1,
      effect: "observation",
      input: { path: "missing.ts" },
      signal: new AbortController().signal,
    });
    expect(missing.status).toBe("failed");
  });

  test("fails closed for unknown tool names", async () => {
    const tools = toolsUnder();
    const outcome = await tools.runner.execute({
      invocationId: invocationId.from("inv-unk"),
      toolCallId: "call-unk",
      toolName: "shell",
      capabilityId: capabilityId.from("builtin:workspace/read_file@1"),
      version: 1,
      effect: "observation",
      input: {},
      signal: new AbortController().signal,
    });
    expect(outcome.status).toBe("unavailable");
  });

  test("publishes a successful write into the index before returning", async () => {
    const fileSystem = createInMemoryFileSystem({
      nodes: {
        "/work/project": { kind: "directory" },
        "/work/project/existing.ts": { kind: "file", text: "export const old = true;\n" },
      },
    });
    const index = createEphemeralProductIndexPort();
    const lifecycle = composeProductIndexLifecycle({ fileSystem, workspaceRoot: root, index });
    expect((await lifecycle.rebuild()).ok).toBe(true);
    const tools = composeProductWorkspaceTools({
      generation: configurationGeneration.from(0),
      fileSystem,
      commands: createStubCommandRunner(() => ({ kind: "exited", exitCode: 1, stdout: "" })),
      workspaceRoot: root,
      index,
    });
    const merged = mergeProductToolBundles(configurationGeneration.from(0), [tools], {
      afterMutation: async (request) => {
        tools.invalidateContext();
        return (await lifecycle.refresh(request.signal)).ok;
      },
    });

    const written = await merged.runner.execute({
      invocationId: invocationId.from("inv-write-index"),
      toolCallId: "call-write-index",
      toolName: "write_files",
      capabilityId: capabilityId.from("builtin:workspace/write_files@1"),
      version: 1,
      effect: "mutation",
      input: {
        targets: [{ kind: "create", path: "new.ts", text: "export const fresh = true;\n" }],
      },
      signal: new AbortController().signal,
    });

    expect(written.status).toBe("completed");
    const snapshot = await index.snapshot(root);
    expect(snapshot.ok).toBe(true);
    expect(
      snapshot.ok && snapshot.value.records.some((record) => record.logical === "new.ts"),
    ).toBe(true);
  });

  test("keeps a completed mutation truthful when index publication is unavailable", async () => {
    const tools = toolsUnder();
    const merged = mergeProductToolBundles(configurationGeneration.from(0), [tools], {
      afterMutation: async () => false,
    });
    const written = await merged.runner.execute({
      invocationId: invocationId.from("inv-write-unavailable-index"),
      toolCallId: "call-write-unavailable-index",
      toolName: "write_files",
      capabilityId: capabilityId.from("builtin:workspace/write_files@1"),
      version: 1,
      effect: "mutation",
      input: {
        targets: [{ kind: "create", path: "pending.ts", text: "export const pending = true;\n" }],
      },
      signal: new AbortController().signal,
    });

    expect(written.status).toBe("completed");
    expect(written.status === "completed" && written.output.workspaceIndex).toEqual({
      status: "unavailable",
      code: "refresh-failed",
    });
  });
});
