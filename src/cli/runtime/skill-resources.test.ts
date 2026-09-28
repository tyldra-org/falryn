import { afterEach, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeterministicProviderScript, ModelRequest } from "../../providers/index.ts";
import { instructionProduct } from "./instruction-product.fixtures.ts";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function product() {
  const home = await mkdtemp(join(tmpdir(), "falryn-skill-resources-"));
  homes.push(home);
  return { home, ...(await instructionProduct(home)) };
}

async function writeBundle(directory: string, files: Record<string, string | Uint8Array>) {
  for (const [path, value] of Object.entries(files)) {
    await mkdir(join(directory, path, ".."), { recursive: true });
    await writeFile(join(directory, path), value);
  }
}
const skill = (name: string, body: string) =>
  `---\nname: "${name}"\ndescription: "Draft release notes."\n---\n${body}\n`;

/** Scripted tool calls, then a final answer. */
function calls(list: readonly Record<string, unknown>[]) {
  return (_request: ModelRequest, index: number): DeterministicProviderScript => {
    const input = list[index];
    return input === undefined
      ? { kind: "text", text: "done", finishReason: "stop" }
      : {
          kind: "tool",
          toolCallId: `skill-resource-${index}`,
          name: "skill_resource",
          argumentFragments: [JSON.stringify(input)],
        };
  };
}
const results = (requests: readonly ModelRequest[]) =>
  requests.map((request) => JSON.stringify(request.messages.at(-1) ?? null));

test("a loaded skill's files are indexed, read on demand beneath its bundle and never executed", async () => {
  const f = await product();
  const marker = join(f.home, "EXECUTED");
  const project = join(f.workspace, ".agents/skills/release-notes");
  await writeBundle(project, {
    "SKILL.md": skill("release-notes", "BODY_SKILL. Follow [the guide](references/guide.md)."),
    "references/guide.md":
      "GUIDE_TEXT [details](details.md) [outside](../../../../outside.md) [gone](missing.md)",
    "references/details.md": "DETAILS_TEXT",
    "assets/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00]),
    "scripts/check.ts": `await Bun.write(${JSON.stringify(marker)}, "ran");`,
  });
  await writeFile(join(f.workspace, "outside.md"), "OUTSIDE_TEXT");
  // A user skill lives outside the workspace; its files resolve beneath its own bundle.
  await writeBundle(join(f.home, ".agents/skills/triage"), {
    "SKILL.md": skill("triage", "BODY_TRIAGE"),
    "references/steps.md": "TRIAGE_STEPS",
  });
  const run = await f.run({
    prompt: "Use release-notes and triage for this release.",
    script: calls([
      { skill: "release-notes", path: "references/guide.md", depth: 2 },
      { skill: "release-notes", path: "assets/logo.png" },
      { skill: "triage", path: "references/steps.md" },
      { skill: "release-notes", path: "../triage/SKILL.md" },
      { skill: "incident", path: "references/steps.md" },
    ]),
  });
  expect(run.result.outcome.kind, JSON.stringify(run.result)).toBe("completed");
  const first = JSON.stringify(run.requests[0]?.messages ?? []);
  // The index names files without reading them, and says scripts are not executable.
  expect(first).toContain("scripts/check.ts (script, text/typescript");
  expect(first).toContain("not executable");
  expect(first).toContain("assets/logo.png (asset, image/png, 7 bytes)");
  expect(first).not.toContain("GUIDE_TEXT");
  expect(run.requests[0]?.tools?.map((tool) => tool.name)).toContain("skill_resource");
  expect(JSON.stringify(run.requests[0]?.tools ?? [])).not.toContain("check.ts");

  const [guide, logo, triage, escaped, unloaded] = results(run.requests).slice(1);
  expect(guide).toContain("GUIDE_TEXT");
  expect(guide).toContain("DETAILS_TEXT");
  expect(guide).toContain('\\"status\\":\\"escaped\\"');
  expect(guide).toContain('\\"status\\":\\"missing\\"');
  expect(guide).not.toContain("OUTSIDE_TEXT");
  expect(logo).toContain('\\"status\\":\\"binary\\"');
  expect(logo).toContain("image/png");
  expect(triage).toContain("TRIAGE_STEPS");
  expect(escaped).toContain('\\"status\\":\\"escaped\\"');
  expect(escaped).not.toContain("BODY_TRIAGE");
  expect(unloaded).toContain("skill-not-loaded");
  // Discovery, loading, indexing and reading never ran the script.
  expect(existsSync(marker)).toBe(false);
});

test("an edited skill refuses resource reads until the next turn admits it", async () => {
  const f = await product();
  const bundle = join(f.workspace, ".agents/skills/release-notes");
  await writeBundle(bundle, {
    "SKILL.md": skill("release-notes", "BODY_FIRST"),
    "references/guide.md": "GUIDE_TEXT",
  });
  const script = calls([{ skill: "release-notes", path: "references/guide.md" }]);
  const run = await f.run({
    prompt: "Use release-notes for v2.",
    script: (request, index) => {
      // The skill changes after it was loaded and before its file is read.
      if (index === 0)
        writeFileSync(join(bundle, "SKILL.md"), skill("release-notes", "BODY_EDITED"));
      return script(request, index);
    },
  });
  expect(run.result.outcome.kind, JSON.stringify(run.result)).toBe("completed");
  const [refused] = results(run.requests).slice(1);
  expect(refused).toContain("skill-changed");
  expect(refused).not.toContain("GUIDE_TEXT");
  const session = run.result.payload?.sessionId;
  if (!session) throw new Error("missing session");
  const next = await f.run({
    prompt: "Continue.",
    session,
    script: calls([{ skill: "release-notes", path: "references/guide.md" }]),
  });
  expect(results(next.requests)[1]).toContain("GUIDE_TEXT");
});

test("a symlinked resource is never listed or followed, and an oversized file is refused unread", async () => {
  const f = await product();
  // A user skill, so workspace trust (which reviews project symlinks) is not the guard here.
  const bundle = join(f.home, ".agents/skills/release-notes");
  await writeBundle(bundle, {
    "SKILL.md": skill("release-notes", "BODY"),
    "references/real.md": "REAL",
  });
  await writeFile(join(f.home, "secret.md"), "SECRET_TEXT");
  await symlink(join(f.home, "secret.md"), join(bundle, "references/link.md"));
  await writeBundle(bundle, { "assets/huge.bin": new Uint8Array(1_048_577) });
  const run = await f.run({
    prompt: "Use release-notes now.",
    script: calls([
      { skill: "release-notes", path: "references/link.md" },
      { skill: "release-notes", path: "assets/huge.bin" },
    ]),
  });
  const first = JSON.stringify(run.requests[0]?.messages ?? []);
  expect(first).toContain("references/real.md");
  expect(first).not.toContain("references/link.md");
  const [linked, huge] = results(run.requests).slice(1);
  expect(linked).toContain('\\"status\\":\\"escaped\\"');
  expect(linked).not.toContain("SECRET_TEXT");
  expect(huge).toContain('\\"status\\":\\"too-large\\"');
  expect(huge).toContain("1048577");
});
