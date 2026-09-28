import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeRuntimeEvent, encodeRuntimeEvent } from "../../domain/sessions/index.ts";
import { snapshotOf } from "../../tui/composer/index.ts";
import { instructionProduct } from "./instruction-product.fixtures.ts";
import { nativePromptShellJourney } from "./native-product-fixtures.ts";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function product(addDirs: readonly string[] = []) {
  const home = await mkdtemp(join(tmpdir(), "falryn-skills-"));
  homes.push(home);
  return { home, ...(await instructionProduct(home, addDirs)) };
}
type Product = Awaited<ReturnType<typeof product>>;

/** Every conventional location, in default priority order, relative to the fixture. */
const LOCATIONS = [
  ["project-falryn", (f: Product) => join(f.workspace, ".falryn/skills")],
  ["project-agents", (f: Product) => join(f.workspace, ".agents/skills")],
  ["project-claude", (f: Product) => join(f.workspace, ".claude/skills")],
  ["user-falryn", (f: Product) => join(f.home, "config/skills")],
  ["user-agents", (f: Product) => join(f.home, ".agents/skills")],
  ["user-claude", (f: Product) => join(f.home, ".claude/skills")],
] as const;

async function writeSkill(
  location: string,
  name: string,
  body: string,
  frontmatter: Record<string, unknown> = {},
) {
  await mkdir(join(location, name), { recursive: true });
  const header = Object.entries({ name, description: "Draft release notes.", ...frontmatter })
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n");
  await writeFile(join(location, name, "SKILL.md"), `---\n${header}\n---\n${body}\n`);
}
const request = (run: Awaited<ReturnType<Product["run"]>>) =>
  JSON.stringify(run.requests[0]?.messages ?? []);

test.each(LOCATIONS)(
  "a skill in %s reaches the actual provider request with its complete body",
  async (origin, location) => {
    const f = await product();
    await writeSkill(location(f), "release-notes", `BODY_${origin}`);
    const run = await f.run({ prompt: "Use release-notes for the v2 release." });
    expect(run.result.outcome.kind, JSON.stringify(run.result)).toBe("completed");
    expect(request(run)).toContain(`BODY_${origin}`);
    const instructions = run.result.payload?.instructions;
    expect(instructions?.skills?.routes).toEqual([
      expect.objectContaining({ name: "release-notes", decision: "loaded" }),
    ]);
    expect(
      instructions?.sources.find((source) => source.kind === "skill" && source.state === "selected")
        ?.origin,
    ).toBe(origin);
  },
);

test("same-named skills in every location load only the highest priority and report the rest", async () => {
  const f = await product();
  for (const [origin, location] of LOCATIONS)
    await writeSkill(location(f), "release-notes", `BODY_${origin}`);
  const run = await f.run({ prompt: "Use release-notes for the v2 release." });
  const text = request(run);
  expect(text).toContain("BODY_project-falryn");
  for (const [origin] of LOCATIONS.slice(1)) expect(text).not.toContain(`BODY_${origin}`);
  const skills = run.result.payload?.instructions?.sources.filter((item) => item.kind === "skill");
  expect(skills?.map((item) => `${item.origin}:${item.state}`).sort()).toEqual(
    LOCATIONS.map(
      ([origin]) => `${origin}:${origin === "project-falryn" ? "selected" : "shadowed"}`,
    ).sort(),
  );
});

test("only automatically eligible, relevant skills load; unrelated bodies stay absent", async () => {
  const f = await product();
  const skills = join(f.workspace, ".agents/skills");
  await writeSkill(skills, "release-notes", "BODY_DEFAULT");
  await writeSkill(skills, "deploy", "BODY_MANUAL_ONLY", { "disable-model-invocation": true });
  await writeSkill(skills, "triage", "BODY_MODEL_ONLY", { "user-invocable": false });
  await writeSkill(skills, "archive", "BODY_NEITHER", {
    "disable-model-invocation": true,
    "user-invocable": false,
  });
  await writeSkill(skills, "rotate", "BODY_MALFORMED", { "disable-model-invocation": "yes" });
  await writeSkill(skills, "forked", "BODY_UNSUPPORTED", { context: "fork" });
  await writeSkill(skills, "incident", "BODY_UNRELATED", {
    description: "Write an incident postmortem.",
  });
  const run = await f.run({
    prompt: "Use release-notes, deploy, triage, archive, rotate and forked for this release.",
  });
  expect(run.result.outcome.kind, JSON.stringify(run.result)).toBe("completed");
  const text = request(run);
  expect(text).toContain("BODY_DEFAULT");
  expect(text).toContain("BODY_MODEL_ONLY");
  for (const absent of [
    "BODY_MANUAL_ONLY",
    "BODY_NEITHER",
    "BODY_MALFORMED",
    "BODY_UNSUPPORTED",
    "BODY_UNRELATED",
  ])
    expect(text).not.toContain(absent);
  const reasons = Object.fromEntries(
    (run.result.payload?.instructions?.sources ?? [])
      .filter((item) => item.kind === "skill")
      .map((item) => [item.name, `${item.state}:${item.reason}`]),
  );
  expect(reasons).toMatchObject({
    rotate: "excluded:malformed-eligibility",
    forked: "excluded:unsupported-control",
  });
  // The model is told why a named skill is missing; manual-only skills are never mentioned.
  const routes = run.result.payload?.instructions?.skills?.routes ?? [];
  expect(
    Object.fromEntries(routes.map((route) => [route.name, `${route.decision}:${route.reason}`])),
  ).toEqual({
    "release-notes": "loaded:named-in-task",
    triage: "loaded:named-in-task",
    rotate: "unavailable:malformed-eligibility",
    forked: "unavailable:unsupported-control",
  });
  expect(text).toContain("Relevant but unavailable: forked (unsupported-control)");
  expect(text).not.toContain("deploy (");
});

test("an activated skill stays for the session, follows edits, survives a restart and leaves when removed", async () => {
  const f = await product();
  const location = join(f.workspace, ".agents/skills");
  await writeSkill(location, "release-notes", "BODY_FIRST");
  const first = await f.run({ prompt: "Use release-notes for v2." });
  const session = first.result.payload?.sessionId;
  if (!session) throw new Error("missing session");
  await writeSkill(location, "release-notes", "BODY_EDITED");
  const later = await f.run({ prompt: "Now fix the build.", session });
  expect(request(later)).toContain("BODY_EDITED");
  expect(later.result.payload?.instructions?.skills?.routes).toEqual([
    expect.objectContaining({ decision: "loaded", reason: "session-active" }),
  ]);
  // A new process resumes the session's activations from its stored receipts.
  const restarted = await instructionProduct(f.home);
  const resumed = await restarted.run({ prompt: "Check the tests.", session });
  expect(request(resumed)).toContain("BODY_EDITED");
  await rm(join(location, "release-notes"), { recursive: true });
  const removed = await restarted.run({ prompt: "Check the tests again.", session });
  expect(removed.result.outcome.kind, JSON.stringify(removed.result)).toBe("completed");
  expect(request(removed)).not.toContain("BODY_EDITED");
  // Receipts replay exactly and carry facts, never bodies.
  if (!first.events?.ok) throw new Error("missing events");
  const receipt = first.events.value.find((event) => event.kind === "instructions.resolved");
  if (!receipt) throw new Error("missing receipt");
  expect(JSON.stringify(receipt)).not.toContain("BODY_FIRST");
  const encoded = encodeRuntimeEvent(receipt);
  if (!encoded.ok) throw new Error("encode");
  expect(decodeRuntimeEvent(encoded.value)).toEqual({ ok: true, value: receipt });
});

test("another root's project skill never loads for the primary root", async () => {
  const other = await mkdtemp(join(tmpdir(), "falryn-skills-other-"));
  homes.push(other);
  await writeSkill(join(other, ".agents/skills"), "release-notes", "BODY_OTHER_ROOT");
  const f = await product([other]);
  const run = await f.run({ prompt: "Use release-notes for v2." });
  expect(run.result.outcome.kind, JSON.stringify(run.result)).toBe("completed");
  expect(request(run)).not.toContain("BODY_OTHER_ROOT");
});

test("the terminal's submission path loads a routed skill into the actual request", async () => {
  const home = await mkdtemp(join(tmpdir(), "falryn-skills-shell-"));
  homes.push(home);
  await mkdir(join(home, "config"), { recursive: true });
  await writeSkill(join(home, ".agents/skills"), "release-notes", "BODY_TERMINAL");
  await writeSkill(join(home, ".agents/skills"), "incident", "BODY_UNRELATED_TERMINAL", {
    description: "Write an incident postmortem.",
  });
  const shell = await nativePromptShellJourney({
    home,
    environment: {
      FALRYN_CONFIG_DIR: join(home, "config"),
      FALRYN_STATE_DIR: join(home, "state"),
    },
    instructions: true,
  });
  try {
    const submitted = await shell.attached.submission.submit(
      snapshotOf("Use release-notes for v2.", 1),
    );
    expect(submitted.kind, JSON.stringify(submitted)).toBe("accepted");
    const text = JSON.stringify(shell.requests[0]?.messages ?? []);
    expect(text).toContain("BODY_TERMINAL");
    expect(text).not.toContain("BODY_UNRELATED_TERMINAL");
  } finally {
    await shell.close();
  }
});
