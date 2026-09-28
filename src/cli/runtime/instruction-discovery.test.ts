import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTRUCTION_DISCOVERY } from "../../domain/context/instruction-sources.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { localPath } from "../../domain/workspace/index.ts";
import { createHostFileSystem } from "../../integrations/index.ts";
import { ancestorChains, discoverInstructionFiles } from "./instruction-discovery.ts";
import { instructionProduct } from "./instruction-product.fixtures.ts";
import { composeInstructionSources } from "./instruction-sources.ts";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function temporary() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "falryn-discovery-")));
  homes.push(home);
  return home;
}
const signal = new AbortController().signal;

describe("walking ancestor chains", () => {
  test("chains run from the root down, parents first, without duplicates", () => {
    expect(ancestorChains(["docs/api", "docs", "src"])).toEqual(["", "docs", "src", "docs/api"]);
    expect(ancestorChains([])).toEqual([""]);
  });

  test("names match exactly, lookalikes are reported, and a symlinked directory ends the chain", async () => {
    const root = await temporary();
    await mkdir(join(root, "docs", "api"), { recursive: true });
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "AGENTS.md"), "root");
    await writeFile(join(root, "docs", "claude.md"), "lookalike");
    await mkdir(join(root, "docs", "api", "FALRYN.md"));
    await writeFile(join(root, "outside", "AGENTS.md"), "outside");
    await symlink(join(root, "outside"), join(root, "docs", "linked"));
    await symlink(join(root, "AGENTS.md"), join(root, "docs", "AGENTS.md"));
    const found = await discoverInstructionFiles(
      createHostFileSystem(),
      localPath(root),
      ["docs/api", "docs/linked"],
      INSTRUCTION_DISCOVERY.projectFiles,
      signal,
    );
    expect(found.map(({ directory, name, problem }) => [directory, name, problem])).toEqual([
      ["", "AGENTS.md", null],
      ["docs", "AGENTS.md", "symlink"],
      ["docs", "claude.md", "unsupported-casing"],
      ["docs/api", "FALRYN.md", "not-a-file"],
    ]);
  });
});

/** A product with real files and no instruction registration at all. */
async function product(addDirs: readonly string[] = []) {
  const home = await temporary();
  const p = await instructionProduct(home, addDirs);
  return { home, ...p };
}
const text = (value: unknown) => JSON.stringify(value);
/** A model workflow step scoped to one subtree, then a final answer. */
function scopedStep(directory: string) {
  const definition = {
    version: 1,
    id: "user/instructions:discovery",
    label: "Discovery scope proof",
    argumentsSchema: { type: "object", properties: {}, additionalProperties: false },
    nodes: [
      {
        key: "model",
        kind: "model",
        instruction: "Return JSON string verified.",
        instructionDirectory: directory,
        resultSchema: { type: "string" },
      },
    ],
    outputs: { verified: { from: "node", node: "model" } },
  };
  return (_request: unknown, index: number) =>
    index === 0
      ? {
          kind: "tool" as const,
          name: "workflow",
          toolCallId: "discovery-workflow",
          argumentFragments: [
            JSON.stringify({
              operation: "execute",
              handle: { id: "discovery-proof", generation: "one" },
              definitionJson: JSON.stringify(definition),
              argumentsJson: "{}",
            }),
          ],
        }
      : { kind: "text" as const, text: index === 1 ? '"verified"' : "Done." };
}

describe("automatic discovery in real turns", () => {
  test("home and root files load without registration, in precedence order, and nothing above the root", async () => {
    const f = await product();
    await writeFile(join(f.home, "config", "AGENTS.md"), "GLOBAL_AGENTS_RULE");
    await writeFile(join(f.home, "config", "CLAUDE.md"), "GLOBAL_CLAUDE_NOT_DISCOVERED");
    await writeFile(join(f.home, "AGENTS.md"), "ABOVE_ROOT_RULE");
    await writeFile(join(f.workspace, "CLAUDE.md"), "ROOT_CLAUDE_RULE");
    await writeFile(join(f.workspace, "AGENTS.md"), "ROOT_AGENTS_RULE");
    await writeFile(join(f.workspace, "FALRYN.md"), "ROOT_FALRYN_RULE");
    await mkdir(join(f.workspace, "docs"));
    await writeFile(join(f.workspace, "docs", "AGENTS.md"), "DOCS_SUBTREE_RULE");
    const run = await f.run();
    expect(run.result.outcome.kind, text(run.result)).toBe("completed");
    const sent = text(run.requests[0]?.messages);
    const order = [
      "GLOBAL_AGENTS_RULE",
      "ROOT_CLAUDE_RULE",
      "ROOT_AGENTS_RULE",
      "ROOT_FALRYN_RULE",
    ];
    for (const rule of order) expect(sent).toContain(rule);
    expect(order.map((rule) => sent.indexOf(rule))).toEqual(
      order.map((rule) => sent.indexOf(rule)).toSorted((a, b) => a - b),
    );
    for (const rule of ["GLOBAL_CLAUDE_NOT_DISCOVERED", "ABOVE_ROOT_RULE", "DOCS_SUBTREE_RULE"])
      expect(sent).not.toContain(rule);
    // Provenance names each discovered source; bodies stay out of it.
    const sources = run.result.payload?.instructions?.sources ?? [];
    expect(
      sources.filter((source) => source.state === "selected").map((source) => source.identity.path),
    ).toEqual(expect.arrayContaining(["AGENTS.md", "CLAUDE.md", "FALRYN.md"]));
    expect(text(sources)).not.toContain("ROOT_AGENTS_RULE");
  });

  test("a subtree turn adds its nested file; the main turn and other roots do not", async () => {
    const f = await product();
    const other = join(f.home, "other-root");
    await mkdir(other);
    await writeFile(join(other, "AGENTS.md"), "OTHER_ROOT_RULE");
    const multi = await instructionProduct(f.home, [other]);
    await writeFile(join(multi.workspace, "AGENTS.md"), "ROOT_AGENTS_RULE");
    await mkdir(join(multi.workspace, "docs", "api"), { recursive: true });
    await writeFile(join(multi.workspace, "docs", "AGENTS.md"), "DOCS_SUBTREE_RULE");
    await writeFile(join(multi.workspace, "docs", "api", "CLAUDE.md"), "API_SUBTREE_RULE");
    const run = await multi.run({ script: scopedStep("docs") });
    expect(run.result.outcome.kind, text(run.result)).toBe("completed");
    const [main, step] = run.requests.map((request) => text(request.messages));
    expect(main).toContain("ROOT_AGENTS_RULE");
    expect(main).not.toContain("DOCS_SUBTREE_RULE");
    expect(step).toContain("ROOT_AGENTS_RULE");
    expect(step).toContain("DOCS_SUBTREE_RULE");
    // docs/api is below the step's scope, so it does not apply to it.
    expect(text(run.requests)).not.toContain("API_SUBTREE_RULE");
    expect(text(run.requests)).not.toContain("OTHER_ROOT_RULE");
    expect(run.result.payload?.instructions?.sources).toContainEqual(
      expect.objectContaining({
        identity: expect.objectContaining({
          root: canonicalDigest({ root: await realpath(other) }),
        }),
        state: "excluded",
        reason: "outside-execution-scope",
      }),
    );
  });

  test("a symlinked directory never reaches a file outside the root", async () => {
    const f = await product();
    await mkdir(join(f.home, "outside"));
    await writeFile(join(f.home, "outside", "AGENTS.md"), "OUTSIDE_SECRET_RULE");
    await symlink(join(f.home, "outside"), join(f.workspace, "linked"));
    const run = await f.run({ script: scopedStep("linked") });
    // The step ran with the root's scope chain; the linked directory was never entered.
    expect(run.result.outcome.kind, text(run.result)).toBe("completed");
    expect(run.requests.length).toBeGreaterThanOrEqual(2);
    expect(text(run.requests)).not.toContain("OUTSIDE_SECRET_RULE");
    expect(text(run.result)).not.toContain("OUTSIDE_SECRET_RULE");
  });

  test("an unusable file is excluded with its reason while the turn continues", async () => {
    const f = await product();
    // Root instruction files are also reviewed by workspace trust, which refuses unusable
    // ones outright; a nested file is discovery's alone to exclude.
    await mkdir(join(f.workspace, "docs"));
    await writeFile(join(f.workspace, "docs", "FALRYN.md"), "DOCS_FALRYN_RULE");
    await writeFile(
      join(f.workspace, "docs", "AGENTS.md"),
      new Uint8Array([0x41, 0xff, 0xfe, 0x42]),
    );
    await writeFile(join(f.workspace, "docs", "CLAUDE.md"), "x".repeat(1_048_577));
    const run = await f.run({ script: scopedStep("docs") });
    expect(run.result.outcome.kind, text(run.result)).toBe("completed");
    expect(text(run.requests[1]?.messages)).toContain("DOCS_FALRYN_RULE");
    // The step's own receipt names each excluded file and why.
    const graph = f.services();
    const prepared = await composeInstructionSources(graph).prepare({
      root: canonicalDigest({ root: await realpath(f.workspace) }),
      directory: "docs",
      execution: "discovery-proof",
      kind: "child",
    });
    if (!prepared.ok) throw new Error(prepared.code);
    const reasons = Object.fromEntries(
      prepared.binding.receipt.sources.map((source) => [source.identity.path, source.reason]),
    );
    expect(reasons).toMatchObject({
      "docs/FALRYN.md": "instruction-composition",
      "docs/AGENTS.md": "malformed-utf8",
      "docs/CLAUDE.md": "oversized",
    });
  });

  test("alternating main and subtree turns keep one stable generation", async () => {
    const f = await product();
    await writeFile(join(f.workspace, "AGENTS.md"), "ROOT_AGENTS_RULE");
    await mkdir(join(f.workspace, "docs"));
    await writeFile(join(f.workspace, "docs", "AGENTS.md"), "DOCS_SUBTREE_RULE");
    const graph = f.services();
    await graph.workspaceTrust.resolve(async () => "proceed");
    const owner = composeInstructionSources(graph);
    const root = canonicalDigest({ root: await realpath(f.workspace) });
    const prepare = async (directory: string, kind: "main" | "child") => {
      const prepared = await owner.prepare({ root, directory, execution: kind, kind });
      if (!prepared.ok) throw new Error(prepared.code);
      return prepared.binding.receipt;
    };
    await prepare("", "main");
    // The first subtree turn discovers its chain: one truthful new generation.
    const child = await prepare("docs", "child");
    expect(child.reload).toBe("committed");
    const main = await prepare("", "main");
    expect(main.reload).toBe("unchanged");
    expect(main.generation).toBe(child.generation);
    expect((await prepare("docs", "child")).reload).toBe("unchanged");
  });

  test("an untrusted workspace's files are listed but never read; the user-wide file still loads", async () => {
    const f = await product();
    await writeFile(join(f.home, "config", "AGENTS.md"), "GLOBAL_AGENTS_RULE");
    await writeFile(join(f.workspace, "AGENTS.md"), "UNTRUSTED_PROJECT_RULE");
    const graph = f.services();
    // No trust decision has been made for this workspace.
    expect(graph.workspaceTrust.current().status).not.toBe("accepted");
    const prepared = await composeInstructionSources(graph).prepare({
      root: canonicalDigest({ root: await realpath(f.workspace) }),
      directory: "",
      execution: "untrusted-proof",
      kind: "main",
    });
    if (!prepared.ok) throw new Error(prepared.code);
    const sent = text(prepared.binding.sections);
    expect(sent).toContain("GLOBAL_AGENTS_RULE");
    expect(sent).not.toContain("UNTRUSTED_PROJECT_RULE");
    expect(prepared.binding.receipt.sources).toContainEqual(
      expect.objectContaining({
        identity: expect.objectContaining({ path: "AGENTS.md" }),
        origin: "project-agents",
        digest: null,
        reason: "untrusted",
      }),
    );
  });

  test("a lookalike name is reported and never loaded", async () => {
    const f = await product();
    await writeFile(join(f.workspace, "agents.md"), "LOOKALIKE_RULE");
    const run = await f.run();
    expect(run.result.outcome.kind, text(run.result)).toBe("completed");
    expect(text(run.requests)).not.toContain("LOOKALIKE_RULE");
    expect(run.result.payload?.instructions?.sources).toContainEqual(
      expect.objectContaining({
        identity: expect.objectContaining({ path: "agents.md" }),
        state: "excluded",
        reason: "unsupported-casing",
      }),
    );
  });

  test("edits and deletions apply to the next turn", async () => {
    const f = await product();
    await writeFile(join(f.workspace, "AGENTS.md"), "FIRST_RULE");
    expect(text((await f.run()).requests)).toContain("FIRST_RULE");
    await writeFile(join(f.workspace, "AGENTS.md"), "EDITED_RULE");
    const edited = text((await f.run()).requests);
    expect(edited).toContain("EDITED_RULE");
    expect(edited).not.toContain("FIRST_RULE");
    await rm(join(f.workspace, "AGENTS.md"));
    const removed = await f.run();
    expect(removed.result.outcome.kind).toBe("completed");
    expect(text(removed.requests)).not.toContain("EDITED_RULE");
  });
});
