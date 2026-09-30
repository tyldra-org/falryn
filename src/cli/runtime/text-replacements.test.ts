import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProductResources } from "../../application/orchestration/product-resources.ts";
import { composeProductAgentRuntime } from "../../application/runtime/product-agent-runtime.ts";
import { createProductLiveTurnExecutor } from "../../application/runtime/product-live-turn.ts";
import { composeProductWorkspaceTools } from "../../application/tools/product-tools-workspace.ts";
import {
  capabilityId,
  configurationGeneration,
  createStaticEnvironment,
  createSystemClock,
  invocationId,
  sessionId,
  streamId,
  traceId,
  turnId,
  workspaceId,
} from "../../domain/foundation/index.ts";
import { createStubCommandRunner } from "../../domain/process/index.ts";
import { createInMemoryFileSystem, localPath } from "../../domain/workspace/index.ts";
import { createDeterministicProviderAdapter, type ModelRequest } from "../../providers/index.ts";
import { LIVE_TURN_MATRIX_CONFIRMATION } from "../live-turn-matrix.test-support.ts";
import { openProductArtifactSession } from "./product-artifact-session.ts";
import { createServiceProvider } from "./services.ts";

const homes: string[] = [];
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

const SOURCE = "export const oldName = 1;\nexport function use() {\n  return oldName;\n}\n";
const TEST = 'import { oldName } from "./source.ts";\nexpect(oldName).toBe(1);\n';
const CONFIG = '{ "strict": true }\n';

async function fixture(files: Record<string, string | Uint8Array> = {}, session = "session-996") {
  const home = await mkdtemp(join(tmpdir(), "falryn-replace-"));
  homes.push(home);
  const services = createServiceProvider(
    {
      color: "never",
      format: "human",
      nonInteractive: true,
      profile: null,
      quiet: false,
      timeoutMs: null,
      verbose: false,
      workspace: null,
      addDirs: [],
      help: false,
      version: false,
    },
    {
      home: localPath(home),
      platform: "darwin",
      environment: createStaticEnvironment({
        FALRYN_STATE_DIR: join(home, "state"),
        FALRYN_CONFIG_DIR: join(home, "config"),
      }),
      currentDirectory: localPath(home),
    },
  )();
  const durable = await openProductArtifactSession(services);
  if (!durable) throw new Error("durable store unavailable");
  closers.push(() => durable.close());
  const nodes: Record<
    string,
    { kind: "directory" } | { kind: "file"; text: string } | { kind: "file"; bytes: Uint8Array }
  > = {
    "/workspace": { kind: "directory" },
  };
  for (const [path, value] of Object.entries({
    "source.ts": SOURCE,
    "source.test.ts": TEST,
    "tsconfig.json": CONFIG,
    ...files,
  }))
    nodes[`/workspace/${path}`] =
      typeof value === "string" ? { kind: "file", text: value } : { kind: "file", bytes: value };
  const fileSystem = createInMemoryFileSystem({ nodes } as Parameters<
    typeof createInMemoryFileSystem
  >[0]);
  const compose = (owner: string) =>
    composeProductWorkspaceTools({
      generation: configurationGeneration.from(0),
      fileSystem,
      commands: createStubCommandRunner(() => ({ kind: "exited", exitCode: 1, stdout: "" })),
      workspaceRoot: localPath("/workspace"),
      workspaceId: workspaceId.from("workspace-996"),
      sessionId: sessionId.from(owner),
      artifacts: durable.artifacts,
      loom: durable.loom,
      scratch: durable.scratch,
    });
  const tools = compose(session);
  const run = async (
    name: string,
    input: Record<string, unknown>,
    signal = new AbortController().signal,
  ) =>
    tools.runner.execute({
      invocationId: invocationId.from(`call-${name}-${Math.random()}`),
      toolCallId: name,
      toolName: name,
      capabilityId: capabilityId.from(`builtin:workspace/${name}@1`),
      version: 1,
      effect: name === "apply_patch" ? "mutation" : "observation",
      input,
      signal,
    });
  const file = async (path: string) => {
    const read = await fileSystem.readBytes(localPath(`/workspace/${path}`), 1 << 20);
    if (!read.ok) throw new Error("unreadable");
    return new TextDecoder().decode(read.value);
  };
  const write = (path: string, text: string) =>
    fileSystem.writeBytes(localPath(`/workspace/${path}`), new TextEncoder().encode(text));
  /** Read one file (optionally a line range) and return its issued evidence reference. */
  const evidence = async (path: string, lines?: { start: number; end: number }) => {
    const read = await run("read", {
      resources: [{ kind: "workspace", path }],
      ...(lines === undefined ? {} : { projection: { kind: "lines", ...lines } }),
    });
    const reference = /resource-evidence-[0-9a-f-]+/u.exec(JSON.stringify(read))?.[0];
    if (!reference) throw new Error(`no evidence: ${JSON.stringify(read)}`);
    return reference;
  };
  return { durable, fileSystem, tools, compose, run, file, write, evidence };
}

const request = (
  targets: { itemId: string; evidenceRef: string; replacements: Record<string, unknown>[] }[],
  extra: Record<string, unknown> = {},
) => ({ version: 1, kind: "text-replacements", targets, ...extra });
const rename = (itemId: string, oldText: string, newText: string, replaceAll = false) => ({
  itemId,
  oldText,
  newText,
  replaceAll,
});
function output(
  outcome: Awaited<
    ReturnType<ReturnType<typeof composeProductWorkspaceTools>["runner"]["execute"]>
  >,
) {
  if (outcome.status !== "completed") throw new Error(JSON.stringify(outcome));
  return outcome.output as Record<string, unknown> & { patch: Record<string, unknown> };
}

test("one call prepares a two-file replacement; apply writes exactly it and returns successor evidence", async () => {
  const f = await fixture();
  const prepared = output(
    await f.run(
      "prepare_replacements",
      request([
        {
          itemId: "source",
          evidenceRef: await f.evidence("source.ts"),
          replacements: [
            rename("decl", "export const oldName =", "export const newName ="),
            rename("use", "return oldName;", "return newName;"),
          ],
        },
        {
          itemId: "test",
          evidenceRef: await f.evidence("source.test.ts"),
          replacements: [rename("imports", "oldName", "newName", true)],
        },
      ]),
    ),
  );
  expect(prepared).toMatchObject({
    targets: [
      {
        itemId: "source",
        path: "source.ts",
        evidence: "reused",
        scope: "complete-file",
        replacements: [
          { itemId: "decl", matches: 1 },
          { itemId: "use", matches: 1 },
        ],
      },
      {
        itemId: "test",
        path: "source.test.ts",
        replacements: [
          {
            itemId: "imports",
            matches: 2,
            lines: [
              { start: 1, end: 1 },
              { start: 2, end: 2 },
            ],
          },
        ],
      },
    ],
    preview: {
      targets: [
        { hunks: [{ status: "ready" }, { status: "ready" }] },
        { hunks: [{ status: "ready" }] },
      ],
    },
  });
  // Preparation is read-only.
  expect(await f.file("source.ts")).toBe(SOURCE);
  const applied = output(await f.run("apply_patch", prepared.patch));
  expect(applied).toMatchObject({
    items: [{ status: "applied" }, { status: "applied" }],
    rollback: { status: "not-attempted" },
  });
  expect(await f.file("source.ts")).toBe(SOURCE.replaceAll("oldName", "newName"));
  expect(await f.file("source.test.ts")).toBe(TEST.replaceAll("oldName", "newName"));
  expect(await f.file("tsconfig.json")).toBe(CONFIG);
  const successors = applied.successors as { status: string; evidenceRef: string; path: string }[];
  expect(successors.map((item) => [item.path, item.status])).toEqual([
    ["source.ts", "issued"],
    ["source.test.ts", "issued"],
  ]);
  // The successor reference supports the next edit without another model read.
  const next = output(
    await f.run(
      "prepare_replacements",
      request([
        {
          itemId: "again",
          evidenceRef: successors[0]?.evidenceRef ?? "",
          replacements: [rename("value", "newName = 1", "newName = 2")],
        },
      ]),
    ),
  );
  output(await f.run("apply_patch", next.patch));
  expect(await f.file("source.ts")).toContain("newName = 2");
});

test("exact search hits are evidence; a repeat outside the covered range stays unambiguous but unreachable", async () => {
  const f = await fixture({ "repeat.ts": "const a = 1;\nconst b = 1;\nconst c = 1;\n" });
  const searched = await f.run("search", { mode: "literal", query: "const b" });
  const reference = /resource-evidence-[0-9a-f-]+/u.exec(JSON.stringify(searched))?.[0] ?? "";
  expect(JSON.stringify(searched)).toContain('"exactMatchEvidence":true');
  const prepared = output(
    await f.run(
      "prepare_replacements",
      request([
        { itemId: "t", evidenceRef: reference, replacements: [rename("r", "= 1;", "= 2;")] },
      ]),
    ),
  );
  expect(prepared).toMatchObject({
    targets: [{ scope: "covered-ranges", replacements: [{ lines: [{ start: 2, end: 2 }] }] }],
  });
  output(await f.run("apply_patch", prepared.patch));
  expect(await f.file("repeat.ts")).toBe("const a = 1;\nconst b = 2;\nconst c = 1;\n");
  const refused = await f.run(
    "prepare_replacements",
    request([
      {
        itemId: "t",
        evidenceRef: await f.evidence("repeat.ts", { start: 2, end: 2 }),
        replacements: [rename("r", "const c", "const d")],
      },
    ]),
  );
  expect(refused).toMatchObject({
    status: "failed",
    reason: "match-outside-evidence item=r recovery=read-more",
  });
  const all = await f.run(
    "prepare_replacements",
    request([
      {
        itemId: "t",
        evidenceRef: await f.evidence("repeat.ts", { start: 1, end: 2 }),
        replacements: [rename("r", "const", "let", true)],
      },
    ]),
  );
  expect(all).toMatchObject({
    reason: "replace-all-needs-complete-evidence item=r recovery=read-more",
  });
});

test("freshness: exact evidence goes stale; covered ranges survive unrelated edits but never a shift", async () => {
  const f = await fixture();
  const whole = await f.evidence("source.ts");
  const excerpt = await f.evidence("source.ts", { start: 3, end: 3 });
  const change = [rename("r", "return oldName;", "return 42;")];
  // An unrelated same-length edit outside the covered line.
  await f.write("source.ts", SOURCE.replace("= 1;", "= 7;"));
  expect(
    await f.run(
      "prepare_replacements",
      request([{ itemId: "t", evidenceRef: whole, replacements: change }]),
    ),
  ).toMatchObject({
    status: "failed",
    reason: "evidence-stale item=t recovery=read-again",
  });
  const refreshed = output(
    await f.run(
      "prepare_replacements",
      request([{ itemId: "t", evidenceRef: excerpt, replacements: change }], {
        freshness: "covered-ranges",
      }),
    ),
  );
  expect(refreshed).toMatchObject({ targets: [{ evidence: "refreshed" }] });
  // A line inserted above shifts the covered bytes: fresh evidence is required.
  await f.write("source.ts", `// header\n${SOURCE}`);
  expect(
    await f.run(
      "prepare_replacements",
      request([{ itemId: "t", evidenceRef: excerpt, replacements: change }], {
        freshness: "covered-ranges",
      }),
    ),
  ).toMatchObject({ reason: "covered-range-changed item=t recovery=read-again" });
  // The plan prepared before the shift cannot be applied either.
  expect(output(await f.run("apply_patch", refreshed.patch))).toMatchObject({
    items: [{ status: "failed", error: { code: "digest-mismatch" } }],
  });
  expect(await f.file("source.ts")).toBe(`// header\n${SOURCE}`);
});

test("declared dependencies must stay unchanged through apply", async () => {
  const f = await fixture();
  const input = request(
    [
      {
        itemId: "t",
        evidenceRef: await f.evidence("source.ts"),
        replacements: [rename("r", "= 1;", "= 2;")],
      },
    ],
    { dependencies: [{ itemId: "config", evidenceRef: await f.evidence("tsconfig.json") }] },
  );
  const prepared = output(await f.run("prepare_replacements", input));
  expect(prepared).toMatchObject({
    dependencies: [{ itemId: "config", path: "tsconfig.json", evidence: "reused" }],
  });
  await f.write("tsconfig.json", '{ "strict": false }\n');
  expect(await f.run("apply_patch", prepared.patch)).toMatchObject({
    status: "failed",
    reason: "dependency-changed",
    effect: "none",
  });
  expect(await f.file("source.ts")).toBe(SOURCE);
  expect(await f.run("prepare_replacements", input)).toMatchObject({
    reason: "dependency-changed item=config recovery=read-again",
  });
});

test("a target changed after preview refuses the whole plan before any write", async () => {
  const f = await fixture();
  const prepared = output(
    await f.run(
      "prepare_replacements",
      request([
        {
          itemId: "a",
          evidenceRef: await f.evidence("source.ts"),
          replacements: [rename("r", "= 1;", "= 2;")],
        },
        {
          itemId: "b",
          evidenceRef: await f.evidence("source.test.ts"),
          replacements: [rename("s", "toBe(1)", "toBe(2)")],
        },
      ]),
    ),
  );
  await f.write("source.test.ts", `${TEST}// edited\n`);
  expect(output(await f.run("apply_patch", prepared.patch))).toMatchObject({
    items: [{ status: "unscheduled" }, { status: "failed", error: { code: "digest-mismatch" } }],
  });
  expect(await f.file("source.ts")).toBe(SOURCE);
});

test("fabricated, foreign, duplicate, structural and malformed evidence are refused without effect", async () => {
  const f = await fixture();
  const reference = await f.evidence("source.ts");
  const refuse = async (input: unknown) => {
    const outcome = await f.run("prepare_replacements", input as Record<string, unknown>);
    expect(outcome.status).toBe("failed");
    return outcome.status === "failed" ? outcome.reason : "";
  };
  const one = (evidenceRef: string) =>
    request([{ itemId: "t", evidenceRef, replacements: [rename("r", "= 1;", "= 2;")] }]);
  expect(await refuse(one("resource-evidence-00000000-0000-0000-0000-000000000000"))).toMatch(
    /item=t recovery=read-again$/u,
  );
  // Evidence issued to another session never resolves here.
  const other = f.compose("session-other");
  const foreign =
    /resource-evidence-[0-9a-f-]+/u.exec(
      JSON.stringify(
        await other.runner.execute({
          invocationId: invocationId.from("foreign"),
          toolCallId: "foreign",
          toolName: "read",
          capabilityId: capabilityId.from("builtin:workspace/read@1"),
          version: 1,
          effect: "observation",
          input: { resources: [{ kind: "workspace", path: "source.ts" }] },
          signal: new AbortController().signal,
        }),
      ),
    )?.[0] ?? "";
  expect(await refuse(one(foreign))).toBe("wrong-scope item=t recovery=read-again");
  expect(
    await refuse(
      request([
        { itemId: "a", evidenceRef: reference, replacements: [rename("r", "= 1;", "= 2;")] },
        {
          itemId: "b",
          evidenceRef: await f.evidence("source.ts", { start: 1, end: 1 }),
          replacements: [rename("s", "export", "x")],
        },
      ]),
    ),
  ).toBe("duplicate-target item=b recovery=fix-request");
  const outline = await f.run("read", {
    resources: [{ kind: "workspace", path: "source.ts" }],
    projection: { kind: "outline" },
  });
  const structural = /resource-evidence-[0-9a-f-]+/u.exec(JSON.stringify(outline))?.[0] ?? "";
  expect(await refuse(one(structural))).toBe("evidence-not-exact item=t recovery=read-again");
  expect(
    await refuse({
      ...one(reference),
      targets: [
        {
          itemId: "t",
          evidenceRef: reference,
          replacements: [{ itemId: "r", oldText: "x", newText: "y", extra: 1 }],
        },
      ],
    }),
  ).toBe("malformed-input recovery=fix-request");
  expect(await refuse(one("source.ts"))).toBe("evidence-ref-invalid recovery=fix-request");
  expect(
    await refuse(
      request([
        { itemId: "t", evidenceRef: reference, replacements: [rename("r", "oldName", "x")] },
      ]),
    ),
  ).toBe("ambiguous-match item=r recovery=narrow-old-text");
  const controller = new AbortController();
  controller.abort();
  expect(await f.run("prepare_replacements", one(reference), controller.signal)).toMatchObject({
    status: "cancelled",
  });
  expect(await f.file("source.ts")).toBe(SOURCE);
});

test("CRLF line endings and a UTF-8 BOM survive preparation and apply", async () => {
  const crlf = "first\r\nsecond\r\n";
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("héllo\nworld\n")]);
  const f = await fixture({ "windows.txt": crlf, "bom.txt": bom });
  const prepared = output(
    await f.run(
      "prepare_replacements",
      request([
        {
          itemId: "w",
          evidenceRef: await f.evidence("windows.txt"),
          replacements: [rename("r", "first\nsecond", "one\ntwo")],
        },
        {
          itemId: "b",
          evidenceRef: await f.evidence("bom.txt"),
          replacements: [rename("s", "world", "monde")],
        },
      ]),
    ),
  );
  output(await f.run("apply_patch", prepared.patch));
  expect(await f.file("windows.txt")).toBe("one\r\ntwo\r\n");
  const read = await f.fileSystem.readBytes(localPath("/workspace/bom.txt"), 1024);
  expect(read.ok && [...read.value.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  expect(await f.file("bom.txt")).toBe("héllo\nmonde\n");
});

test("a model turn reads, prepares and applies a two-file replacement through the gateway", async () => {
  const f = await fixture();
  const requests: ModelRequest[] = [];
  const references = () =>
    [...JSON.stringify(requests.at(-1)).matchAll(/resource-evidence-[0-9a-f-]+/gu)].map(
      (match) => match[0],
    );
  let patch: unknown = null;
  // Record what the gateway returned to the model; the model replays it unchanged.
  const runner = {
    ...f.tools.runner,
    async execute(call: Parameters<typeof f.tools.runner.execute>[0]) {
      const outcome = await f.tools.runner.execute(call);
      if (call.toolName === "prepare_replacements" && outcome.status === "completed")
        patch = outcome.output.patch;
      return outcome;
    },
  };
  const adapter = createDeterministicProviderAdapter({
    onRequest: (value) => requests.push(value),
    script(value, index) {
      if (index === 0)
        return {
          kind: "tool",
          toolCallId: "read",
          name: "read",
          argumentFragments: [
            JSON.stringify({
              resources: [
                { kind: "workspace", path: "source.ts" },
                { kind: "workspace", path: "source.test.ts" },
              ],
            }),
          ],
        };
      if (index === 1) {
        const [source, test] = references();
        return {
          kind: "tool",
          toolCallId: "prepare",
          name: "prepare_replacements",
          argumentFragments: [
            JSON.stringify(
              request(
                [
                  {
                    itemId: "source",
                    evidenceRef: source ?? "",
                    replacements: [
                      rename("decl", "export const oldName =", "export const newName ="),
                    ],
                  },
                  {
                    itemId: "test",
                    evidenceRef: test ?? "",
                    replacements: [rename("import", "import { oldName }", "import { newName }")],
                  },
                ],
                { freshness: "exact-revision", dependencies: [] },
              ),
            ),
          ],
        };
      }
      if (index === 2) {
        if (!JSON.stringify(value).includes("expectedPlanId"))
          return { kind: "text", text: "no plan" };
        return {
          kind: "tool",
          toolCallId: "apply",
          name: "apply_patch",
          argumentFragments: [JSON.stringify(patch)],
        };
      }
      return { kind: "text", text: "renamed" };
    },
  });
  const clock = createSystemClock();
  const runtime = composeProductAgentRuntime({
    eventStore: f.durable.eventStore,
    historyArtifacts: f.durable.artifacts,
    clock,
    resources: createProductResources(clock),
    toolConfirmation: LIVE_TURN_MATRIX_CONFIRMATION,
    streamId: streamId.from("replace-turns"),
    correlation: {
      workspaceId: workspaceId.from("workspace-996"),
      sessionId: sessionId.from("session-996"),
      traceId: traceId.from("replace-trace"),
      configurationGeneration: configurationGeneration.from(0),
    },
    providerAdapter: adapter,
    toolRegistry: f.tools.registry,
    toolRunner: runner,
  });
  if (!runtime.ok) throw new Error(runtime.error.code);
  if (!f.tools.resources) throw new Error("resource reader missing");
  const executor = createProductLiveTurnExecutor({
    runtime: runtime.value,
    artifacts: f.durable.artifacts,
    clock,
    resources: f.tools.resources,
    providerCatalog: {
      generation: 1,
      provenance: "static-config",
      fetchedAt: null,
      expiresAt: null,
      models: adapter.modelCapabilities ?? [],
    },
  });
  const result = await executor.run({
    prompt: "Rename oldName to newName in source and test",
    turnId: turnId.from("replace-turn"),
  });
  // The evidence reader and the preparation tool are both offered to an edit task.
  const offered = JSON.stringify(requests[0]?.tools);
  expect(offered).toContain('"name":"read"');
  expect(offered).toContain('"name":"prepare_replacements"');
  expect({ kind: result.kind, tools: result.toolResults }).toEqual({ kind: "completed", tools: 3 });
  expect(patch).not.toBeNull();
  // One model request per step and no helper-model call.
  expect(requests).toHaveLength(4);
  expect(await f.file("source.ts")).toContain("export const newName = 1;");
  expect(await f.file("source.test.ts")).toContain('import { newName } from "./source.ts";');
  expect(JSON.stringify(requests[3])).toContain("successors");
});
