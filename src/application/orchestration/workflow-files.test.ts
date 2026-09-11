import { expect, test } from "bun:test";
import { bytesDigest, canonicalDigest } from "../../domain/extensions/canonical.ts";
import { simpleWorkflow } from "../../domain/orchestration/workflow.fixtures.ts";
import { workspaceTrustReportSchema } from "../../domain/security/workspace-trust.ts";
import { createInMemoryFileSystem, localPath } from "../../domain/workspace/index.ts";
import { loadWorkflowFiles } from "./workflow-files.ts";

const roots = { configurationRoot: localPath("/config"), workspaceRoot: localPath("/work") };
const globalGraph = {
  ...simpleWorkflow(),
  id: "user/global/workflows:checks",
  label: "Same label",
};
const projectGraph = {
  ...simpleWorkflow(),
  id: "user/project/workflows:checks",
  label: "Same label",
  nodes: [{ ...simpleWorkflow().nodes[0], key: "project-read" }],
  outputs: {},
};
const globalPath = "/config/workflows/checks/workflow.jsonc";
const projectPath = "/work/.falryn/workflows/checks/workflow.jsonc";
function fixture() {
  const fileSystem = createInMemoryFileSystem({
    nodes: {
      "/config": { kind: "directory" },
      "/config/workflows": { kind: "directory" },
      "/config/workflows/checks": { kind: "directory" },
      [globalPath]: { kind: "file", text: JSON.stringify(globalGraph) },
      "/work": { kind: "directory" },
      "/work/.falryn": { kind: "directory" },
      "/work/.falryn/workflows": { kind: "directory" },
      "/work/.falryn/workflows/checks": { kind: "directory" },
      [projectPath]: { kind: "file", text: JSON.stringify(projectGraph) },
    },
  });
  return fileSystem;
}
function trust(status: "accepted" | "review-required") {
  return workspaceTrustReportSchema.parse({
    version: 1,
    status,
    priorGeneration: null,
    reason: "test",
    added: 0,
    removed: 0,
    changed: 0,
    inventory: {
      version: 1,
      identity: canonicalDigest("/work"),
      generation: canonicalDigest("inventory"),
      policy: 1,
      configuration: canonicalDigest("config"),
      loaders: [
        {
          source: canonicalDigest({
            root: "/work",
            relative: ".falryn/workflows/checks/workflow.jsonc",
          }),
          label: "checks",
          sourceVersion: canonicalDigest("version"),
          family: "workflows",
          digest: bytesDigest(new TextEncoder().encode(JSON.stringify(projectGraph))),
          bytes: JSON.stringify(projectGraph).length,
          activation: "definition",
        },
      ],
    },
  });
}
test("saved definitions stay inert and qualified identities survive save/reload without merging same labels", async () => {
  const fileSystem = fixture();
  const loaded = await loadWorkflowFiles({ ...roots, fileSystem, trust: trust("accepted") });
  if (!loaded.ok) throw new Error(loaded.error.code);
  expect(loaded.value.page().total).toBe(2);
  const before = loaded.value.resolve(globalGraph.id);
  expect(before?.definition.nodes[0]?.key).toBe("read");
  fileSystem.put(globalPath, {
    kind: "file",
    text: `// Saved through the normal file owner\n${JSON.stringify({ ...globalGraph, label: "Edited" })}`,
  });
  const next = await loadWorkflowFiles({ ...roots, fileSystem, trust: trust("accepted") });
  if (!next.ok) throw new Error(next.error.code);
  expect(next.value.resolve(globalGraph.id)?.digest).not.toBe(before?.digest);
  expect(before?.label).toBe("Same label");
  expect(next.value.resolve(projectGraph.id)?.definition.nodes[0]?.key).toBe("project-read");
});
test("project definitions require exact reviewed bytes; missing and relocated roots never load another worktree", async () => {
  const fileSystem = fixture();
  const inert = await loadWorkflowFiles({ ...roots, fileSystem, trust: trust("review-required") });
  expect(inert.ok && inert.value.page().total).toBe(1);
  fileSystem.put(projectPath, {
    kind: "file",
    text: JSON.stringify({ ...projectGraph, label: "Changed" }),
  });
  expect(await loadWorkflowFiles({ ...roots, fileSystem, trust: trust("accepted") })).toMatchObject(
    { ok: false, error: { code: "workflow-review-required" } },
  );
  const moved = await loadWorkflowFiles({
    configurationRoot: localPath("/moved"),
    workspaceRoot: localPath("/other-worktree"),
    fileSystem,
    trust: trust("accepted"),
  });
  expect(moved.ok && moved.value.page().total).toBe(0);
});
test("definition symlinks cannot escape the selected root", async () => {
  const fileSystem = fixture();
  fileSystem.put(globalPath, { kind: "symlink", target: projectPath });
  expect(await loadWorkflowFiles({ ...roots, fileSystem, trust: trust("accepted") })).toMatchObject(
    { ok: false },
  );
});
