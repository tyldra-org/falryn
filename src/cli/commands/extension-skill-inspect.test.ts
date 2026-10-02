import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageInspectionLines } from "../../application/extensions/inspection-report.ts";
import { pluginManifest } from "../../application/extensions/package-fixtures.ts";
import { inspectStandaloneSkill, runExtensionInspect } from "./extension.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function directory(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "falryn-skill-inspect-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

const codes = (
  entries: readonly { name: string; findings: readonly { code: string; evidence: unknown }[] }[],
) => entries.map((entry) => [entry.name, entry.findings.map((item) => [item.code, item.evidence])]);

test("inspecting a package reports each bundled skill's findings from the bytes it already read", async () => {
  const root = await directory({
    "plugin.json": JSON.stringify(pluginManifest()),
    "skills/good/SKILL.md":
      "---\nname: good\ndescription: Useful\n---\nSee [guide](references/guide.md).\n",
    "skills/good/references/guide.md": "Guide.",
    "skills/bad/SKILL.md": "---\nname: Wrong\ndescription: Nope\n---\n",
    "skills/manual/SKILL.md":
      "---\nname: manual\ndescription: Manual only\ndisable-model-invocation: true\n---\nRun [it](scripts/missing.sh).\n",
  });
  const result = await runExtensionInspect(join(root));
  const payload = result.payload;
  if (payload?.status !== "inspected" || payload.skills === null)
    throw new Error(JSON.stringify(payload));
  expect(codes(payload.skills.entries)).toEqual([
    ["bad", [["metadata-invalid", { problem: "malformed-metadata", field: "name" }]]],
    ["good", []],
    [
      "manual",
      [
        ["reference-missing", { path: "scripts/missing.sh", state: "missing" }],
        ["restricted", { field: "disable-model-invocation" }],
      ],
    ],
  ]);
  expect(payload.skills.entries.every((entry) => entry.origin === "inspected-package")).toBe(true);
  // Without a configuration graph, MCP servers cannot be checked; that is said, not assumed.
  expect([payload.skills.complete, payload.skills.omissions]).toEqual([
    false,
    ["mcp-configuration-unavailable"],
  ]);
  expect(packageInspectionLines(payload).join("\n")).toContain("metadata-invalid · bad");
});

test("inspecting a standalone skill directory is the deep check: links resolve as skill_resource would, nothing runs", async () => {
  const marker = join(tmpdir(), `falryn-skill-inspect-${crypto.randomUUID()}`);
  const root = await directory({
    "lint-rules/SKILL.md":
      "---\nname: lint-rules\ndescription: Lint rules\nallowed-tools: mcp__github__get_issue\n---\nSee [guide](references/guide.md), [helper](scripts/run.sh), [secret](.env) and [outside](../escape.md).\n",
    "lint-rules/references/guide.md": "Guide.",
    "lint-rules/scripts/present.sh": `#!/bin/sh\ntouch "${marker}"\n`,
  });
  await chmod(join(root, "lint-rules/scripts/present.sh"), 0o755);
  const result = await runExtensionInspect(join(root, "lint-rules"));
  const payload = result.payload;
  if (payload?.status !== "skill-inspected") throw new Error(JSON.stringify(payload));
  expect(payload.bundle).toBe("lint-rules");
  expect(codes(payload.skills.entries)).toEqual([
    [
      "lint-rules",
      [
        ["reference-missing", { path: "scripts/run.sh", state: "missing" }],
        ["reference-missing", { path: ".env", state: "hidden" }],
        ["reference-missing", { path: "../escape.md", state: "escaped" }],
      ],
    ],
  ]);
  expect(payload.skills.entries[0]?.digest).toMatch(/^sha256:/u);
  expect(result.outcome.kind).toBe("completed");
  expect(packageInspectionLines(payload)[0]).toBe(
    "Standalone skill lint-rules; state: declared; nothing loaded, run or installed.",
  );
  expect(await stat(marker).catch(() => null)).toBeNull();
});

test("a deep check that runs out of time keeps its metadata findings and is labelled incomplete", async () => {
  const root = await directory({
    "broken/SKILL.md": "---\nname: broken\n---\nSee [missing](missing.md).\n",
  });
  // A deadline already passed: the directory walk stops before it lists anything.
  const result = await runExtensionInspect(join(root, "broken"), undefined, undefined, undefined, {
    deadlineMs: -1,
  });
  const payload = result.payload;
  if (payload?.status !== "skill-inspected") throw new Error(JSON.stringify(payload));
  expect(payload.skills.complete).toBe(false);
  expect(payload.skills.omissions).toContain("inspection-deadline");
  // Links were not checked, so none is reported missing; the metadata finding stands.
  expect(codes(payload.skills.entries)).toEqual([
    ["broken", [["metadata-invalid", { problem: "malformed-metadata", field: "description" }]]],
  ]);
});

test("cancelling a deep check returns the findings so far, labelled cancelled", async () => {
  const root = await directory({
    "manual/SKILL.md":
      "---\nname: manual\ndescription: Manual\ndisable-model-invocation: true\n---\nSee [x](x.md).\n",
  });
  const controller = new AbortController();
  controller.abort();
  const payload = await inspectStandaloneSkill(
    join(root, "manual"),
    {
      kind: "read",
      ok: true,
      bytes: new Uint8Array(await readFile(join(root, "manual/SKILL.md"))),
    },
    undefined,
    controller.signal,
    undefined,
  );
  if (payload.status !== "skill-inspected") throw new Error(JSON.stringify(payload));
  expect([payload.skills.complete, payload.skills.omissions]).toEqual([false, ["cancelled"]]);
  expect(codes(payload.skills.entries)).toEqual([
    ["manual", [["restricted", { field: "disable-model-invocation" }]]],
  ]);
});
