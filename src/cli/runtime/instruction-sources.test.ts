import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instructionSourceKey } from "../../domain/context/instruction-sources.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import {
  decodeRuntimeEvent,
  encodeRuntimeEvent,
  reduceTurnEvents,
} from "../../domain/sessions/index.ts";
import { startConfigurationReloadWatcher } from "./configuration-reload.ts";
import { instructionProduct } from "./instruction-product.fixtures.ts";
import { composeInstructionSources } from "./instruction-sources.ts";
import {
  loadProductConfiguration,
  productConfigurationLoadRequest,
} from "./product-configuration.ts";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "falryn-instructions-"));
  homes.push(home);
  const product = await instructionProduct(home);
  const workspace = await product.services().ensureWorkspaceSet();
  if (!workspace.ok) throw new Error("fixture workspace");
  const root = workspace.value.set.roots[0];
  if (!root) throw new Error("fixture root");
  const entries = ["AGENTS.md", "FALRYN.md"].map((path) => ({
    root: root.name,
    path,
    scope: "",
    enabled: true,
    references: [],
  }));
  await writeFile(join(product.workspace, "AGENTS.md"), "ROOT_AGENT_RULE");
  await writeFile(join(product.workspace, "FALRYN.md"), "ROOT_FALRYN_RULE");
  await product.setting("instructions.sources", { version: 1, entries });
  return { ...product, home, root, entries };
}
test("real headless input retains ordered instructions and native provenance across save, restart and reset", async () => {
  const f = await fixture();
  const first = await f.run();
  expect(first.result.outcome.kind, JSON.stringify(first.result)).toBe("completed");
  const text = JSON.stringify(first.requests[0]?.messages);
  expect(text).toContain("ROOT_AGENT_RULE");
  expect(text).toContain("ROOT_FALRYN_RULE");
  expect(text.indexOf("ROOT_AGENT_RULE")).toBeLessThan(text.indexOf("ROOT_FALRYN_RULE"));
  expect(
    first.result.payload?.instructions?.sources.filter((source) => source.state === "selected"),
  ).toHaveLength(2);
  expect(JSON.stringify(first.events)).toContain("instructions.resolved");
  if (!first.events?.ok) throw new Error("missing events");
  const receiptEvent = first.events.value.find((event) => event.kind === "instructions.resolved");
  if (!receiptEvent) throw new Error("missing instruction event");
  const encoded = encodeRuntimeEvent(receiptEvent);
  expect(encoded.ok).toBe(true);
  if (encoded.ok)
    expect(decodeRuntimeEvent(encoded.value)).toEqual({ ok: true, value: receiptEvent });
  expect(reduceTurnEvents(first.events.value).turns[0]?.instructions).toEqual(
    first.result.payload?.instructions,
  );
  expect(JSON.stringify(receiptEvent)).not.toContain("ROOT_AGENT_RULE");
  const identity = {
    version: 1 as const,
    kind: "instruction" as const,
    root: canonicalDigest({ root: f.root.path }),
    path: "AGENTS.md",
    namespace: "instructions",
    localId: "AGENTS.md",
  };
  await f.setting(
    "instructions.preferences",
    {
      version: 1,
      choices: [
        { kind: "instruction", name: `${identity.root}:`, source: instructionSourceKey(identity) },
      ],
      restrictions: [],
    },
    "project",
  );
  const restarted = await instructionProduct(f.home);
  const chosen = await restarted.run();
  expect(chosen.result.outcome.kind).toBe("completed");
  expect(JSON.stringify(chosen.requests[0]?.messages)).toContain("ROOT_AGENT_RULE");
  expect(JSON.stringify(chosen.requests[0]?.messages)).not.toContain("ROOT_FALRYN_RULE");
  await rm(join(f.workspace, "AGENTS.md"));
  const missing = await restarted.run();
  expect(missing.requests).toHaveLength(0);
  expect(
    missing.result.payload?.instructionFailure?.sources.some(
      (source) => source.name === "FALRYN.md" && source.state === "shadowed",
    ),
  ).toBe(true);
  expect(missing.result.outcome.kind).not.toBe("completed");
  await restarted.reset("instructions.preferences", "project");
  const reset = await restarted.run();
  expect(reset.result.outcome.kind).toBe("completed");
  expect(JSON.stringify(reset.requests[0]?.messages)).toContain("ROOT_FALRYN_RULE");
});
test("configured references cannot follow a symlink outside an admitted root", async () => {
  const f = await fixture();
  await mkdir(join(f.home, "outside"));
  await writeFile(join(f.home, "outside", "rule.md"), "OUTSIDE_SECRET_RULE");
  await symlink(join(f.home, "outside"), join(f.workspace, "linked"));
  await f.setting("instructions.sources", {
    version: 1,
    entries: [...f.entries, { ...f.entries[0], path: "linked/rule.md" }],
  });
  const result = await f.run();
  expect(result.requests).toHaveLength(0);
  expect(JSON.stringify(result.result)).not.toContain("OUTSIDE_SECRET_RULE");
});

test("model workflow steps resolve their subtree while deterministic steps add no provider call", async () => {
  const f = await fixture();
  await mkdir(join(f.workspace, "docs"));
  await writeFile(join(f.workspace, "docs", "rules.md"), "WORKFLOW_DOCS_RULE");
  await f.setting("instructions.sources", {
    version: 1,
    entries: [
      ...f.entries,
      { root: f.root.name, path: "docs/rules.md", scope: "docs", enabled: true, references: [] },
    ],
  });
  const definition = {
    version: 1,
    id: "user/instructions:workflow",
    label: "Instruction scope proof",
    argumentsSchema: { type: "object", properties: {}, additionalProperties: false },
    nodes: [
      {
        key: "condition",
        kind: "condition",
        value: { from: "literal", value: true },
        equals: true,
        resultPath: ["matches"],
        resultSchema: { type: "boolean" },
      },
      {
        key: "model",
        dependencies: ["condition"],
        kind: "model",
        instruction: "Return JSON string verified.",
        instructionDirectory: "docs",
        resultSchema: { type: "string" },
      },
    ],
    outputs: { verified: { from: "node", node: "model" } },
  };
  const result = await f.run(undefined, (_request, index) =>
    index === 0
      ? {
          kind: "tool",
          name: "workflow",
          toolCallId: "instructions-workflow",
          argumentFragments: [
            JSON.stringify({
              operation: "execute",
              handle: { id: "instructions-proof", generation: "one" },
              definitionJson: JSON.stringify(definition),
              argumentsJson: "{}",
            }),
          ],
        }
      : { kind: "text", text: index === 1 ? '"verified"' : "Workflow complete." },
  );
  expect(result.result.outcome.kind, JSON.stringify(result.result)).toBe("completed");
  expect(
    result.requests,
    JSON.stringify(result.requests.at(-1)?.messages.filter((message) => message.role === "tool")),
  ).toHaveLength(3);
  expect(JSON.stringify(result.requests[0]?.messages)).not.toContain("WORKFLOW_DOCS_RULE");
  expect(JSON.stringify(result.requests[1]?.messages)).toContain("WORKFLOW_DOCS_RULE");
  expect(JSON.stringify(result.requests[2]?.messages)).not.toContain("WORKFLOW_DOCS_RULE");
});

test("revocation after a provider request prevents its proposed read and any continuation", async () => {
  const f = await fixture();
  await writeFile(join(f.workspace, "private.txt"), "READ_MUST_NOT_HAPPEN");
  let revoked = false;
  const result = await f.run(
    async () => {
      if (revoked) return;
      revoked = true;
      await f.setting("instructions.sources", {
        version: 1,
        entries: f.entries.map((entry) => ({ ...entry, enabled: false })),
      });
      const graph = f.services();
      await graph.loader.load({
        configurationRoot: graph.configurationRoot,
        workspaceRoot: graph.workspaceRoot,
        profile: null,
      });
    },
    (_request, index) =>
      index === 0
        ? {
            kind: "tool",
            name: "read_file",
            toolCallId: "revoked-read",
            argumentFragments: [JSON.stringify({ path: "private.txt" })],
          }
        : { kind: "text", text: "Should not continue" },
  );
  expect(result.requests).toHaveLength(1);
  expect(result.result.outcome.kind, JSON.stringify(result.result)).not.toBe("completed");
  expect(
    result.events?.ok && result.events.value.some((event) => event.kind === "instructions.revoked"),
  ).toBe(true);
  expect(JSON.stringify(result.events)).not.toContain("READ_MUST_NOT_HAPPEN");
  if (!result.events?.ok) throw new Error("missing events");
  expect(reduceTurnEvents(result.events.value).turns[0]?.instructionAuthority).toBe("revoked");
  const attempts = result.events.value.filter((event) => event.kind === "model.attempt.completed");
  expect(
    attempts.every((event) =>
      event.payload.admissions?.every((receipt) => !receipt.acquired || receipt.released),
    ),
  ).toBe(true);
});

test("a declared instruction conflict refuses provider dispatch with source alternatives", async () => {
  const f = await fixture();
  await f.setting("instructions.sources", {
    version: 1,
    entries: f.entries.map((entry) => ({
      ...entry,
      conflicts: entry.path === "AGENTS.md" ? ["FALRYN.md"] : [],
    })),
  });
  const result = await f.run();
  expect(result.requests).toHaveLength(0);
  expect(
    result.result.payload?.instructionFailure?.sources.some(
      (source) => source.state === "conflicting",
    ),
  ).toBe(true);
  expect(
    result.events?.ok &&
      result.events.value.some((event) => event.kind === "instructions.rejected"),
  ).toBe(true);
  if (result.events?.ok)
    expect(
      reduceTurnEvents(result.events.value).turns[0]?.instructionFailure?.sources.some(
        (source) => source.state === "conflicting",
      ),
    ).toBe(true);
});

test("another admitted workspace root cannot supply main-root instructions", async () => {
  const f = await fixture();
  const extra = join(f.home, "other-root");
  await mkdir(extra);
  await writeFile(join(extra, "AGENTS.md"), "OTHER_ROOT_RULE");
  const multi = await instructionProduct(f.home, [extra]);
  const workspace = await multi.services().ensureWorkspaceSet();
  if (!workspace.ok) throw new Error("fixture workspace");
  const canonicalExtra = await realpath(extra);
  const root = workspace.value.set.roots.find((item) => item.path === canonicalExtra);
  if (!root) throw new Error("fixture additional root");
  await multi.setting("instructions.sources", {
    version: 1,
    entries: [...f.entries, { ...f.entries[0], root: root.name }],
  });
  const run = await multi.run();
  expect(run.result.outcome.kind).toBe("completed");
  expect(JSON.stringify(run.requests)).not.toContain("OTHER_ROOT_RULE");
  expect(run.result.payload?.instructions?.sources).toContainEqual(
    expect.objectContaining({
      identity: expect.objectContaining({ root: canonicalDigest({ root: canonicalExtra }) }),
      state: "excluded",
      reason: "outside-execution-scope",
    }),
  );
});

test("the existing watcher rescans changed sources and retains exact malformed-source diagnostics", async () => {
  const f = await fixture();
  const graph = f.services();
  await graph.workspaceTrust.resolve(async () => "proceed");
  await loadProductConfiguration(graph, productConfigurationLoadRequest(f.globals));
  const owner = composeInstructionSources(graph);
  const scope = {
    root: canonicalDigest({ root: f.root.path }),
    directory: "",
    execution: "watcher-test",
    kind: "main" as const,
  };
  const initial = await owner.prepare(scope);
  expect(initial.ok).toBe(true);
  let changed = () => {};
  let observed = 0;
  const watcher = startConfigurationReloadWatcher(graph, f.globals, {
    subscribe: async (_paths, notify) => {
      changed = notify;
      return { dispose() {} };
    },
    // The instruction owner uses the same callback that production profile and run hosts use.
    onSourcesChanged: async (signal) => {
      await owner.prepare(scope, [], signal, undefined, true);
      observed++;
    },
  });
  try {
    await writeFile(join(f.workspace, "FALRYN.md"), new Uint8Array([0xff]));
    changed();
    const deadline = Date.now() + 2000;
    while (!observed && Date.now() < deadline) await Bun.sleep(5);
    expect(observed).toBe(1);
    const retained = await owner.prepare(scope);
    expect(retained).toMatchObject({
      ok: true,
      binding: {
        receipt: {
          reload: "rejected",
          rejection: "source-invalid",
          rejectedSource: instructionSourceKey({
            version: 1,
            kind: "instruction",
            root: scope.root,
            path: "FALRYN.md",
            namespace: "instructions",
            localId: "FALRYN.md",
          }),
        },
      },
    });
    if (retained.ok && initial.ok)
      expect(retained.binding.sections).toEqual(initial.binding.sections);
  } finally {
    watcher.dispose();
  }
});

test("registered references resolve beside the declaring file without changing authority", async () => {
  const f = await fixture();
  await writeFile(join(f.workspace, "guide.md"), "RELATIVE_GUIDANCE");
  await f.setting("instructions.sources", {
    version: 1,
    entries: [
      ...f.entries.map((entry) => ({
        ...entry,
        references: entry.path === "FALRYN.md" ? ["guide.md"] : [],
      })),
      { ...f.entries[0], path: "guide.md" },
    ],
  });
  const result = await f.run();
  expect(result.result.outcome.kind).toBe("completed");
  const request = JSON.stringify(result.requests[0]?.messages);
  expect(request).toContain("RELATIVE_GUIDANCE");
  expect(request.indexOf("RELATIVE_GUIDANCE")).toBeLessThan(request.indexOf("ROOT_FALRYN_RULE"));
});

test("host source reads have an allocation bound even when a file grows after stat", async () => {
  const f = await fixture();
  const graph = f.services();
  await graph.workspaceTrust.resolve(async () => "proceed");
  await loadProductConfiguration(graph, productConfigurationLoadRequest(f.globals));
  const lengths: number[] = [];
  const owner = composeInstructionSources({
    ...graph,
    fileSystem: {
      ...graph.fileSystem,
      async readBytes() {
        throw new Error("unbounded source read");
      },
      async readBytesRange(_path, offset, length) {
        expect(offset).toBe(0);
        lengths.push(length);
        return { ok: true, value: new Uint8Array(length) };
      },
    },
  });
  const result = await owner.prepare({
    root: canonicalDigest({ root: f.root.path }),
    directory: "",
    execution: "growing-source",
    kind: "main",
  });
  expect(result).toMatchObject({ ok: false, code: "instruction-source-byte-limit" });
  expect(lengths).toEqual([1048577]);
  expect(owner.snapshot()).toBeNull();
});
