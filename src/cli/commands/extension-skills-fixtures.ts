/**
 * A real skill usage journey: headless turns admit two same-named skills through the
 * product host, then `extension skills` runs as a separate process against the same
 * state. Source and compiled tests pass their own command and assert the same facts.
 */
import { expect } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SkillUsageReport } from "../../application/extensions/skill-usage.ts";
import { estimatePromptTokens } from "../../domain/context/prompt-composition.ts";
import type { RuntimeEvent } from "../../domain/sessions/index.ts";
import { instructionProduct } from "../runtime/instruction-product.fixtures.ts";
import { runExtensionSkills } from "./extension-skills.ts";

const BODY = "Draft the notes from merged pull requests.";

async function writeSkill(location: string, body: string) {
  await mkdir(join(location, "release-notes"), { recursive: true });
  await writeFile(
    join(location, "release-notes", "SKILL.md"),
    `---\nname: "release-notes"\ndescription: "Draft release notes."\n---\n${body}\n`,
  );
}

export async function skillUsageCliJourney(command: readonly string[], home: string) {
  const product = await instructionProduct(home);
  const project = join(product.workspace, ".agents/skills");
  const user = join(home, ".agents/skills");
  await writeSkill(project, BODY);
  await writeSkill(user, "USER_COPY_NEVER_LOADED");
  const first = await product.run({ prompt: "Use release-notes for the v2 release." });
  const session = first.result.payload?.sessionId;
  if (!session) throw new Error("missing session");
  await product.run({ prompt: "Now fix the build.", session });
  await writeSkill(project, `${BODY} Edited.`);
  const last = await product.run({ prompt: "Check the tests.", session });
  if (!last.events?.ok) throw new Error("missing events");
  const events: readonly RuntimeEvent[] = last.events.value;

  const cli = (args: readonly string[]) => {
    const child = Bun.spawnSync([...command, "extension", "skills", ...args], {
      cwd: product.workspace,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        USERPROFILE: home,
        NO_COLOR: "1",
        FALRYN_CONFIG_DIR: join(home, "config"),
        FALRYN_STATE_DIR: join(home, "state"),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: child.exitCode,
      stdout: child.stdout.toString(),
      stderr: child.stderr.toString(),
    };
  };
  const json = cli(["--format", "json"]);
  expect(json.exitCode, json.stderr).toBe(0);
  const report = JSON.parse(json.stdout).payload as SkillUsageReport;
  const inProcess = (await runExtensionSkills(product.services, {})).payload;
  // The separate process and the in-process owner read the same facts.
  expect(report).toEqual(inProcess as SkillUsageReport);
  if (report.status !== "reported") throw new Error(report.status);

  const receipts = events.filter((event) => event.kind === "instructions.resolved");
  expect(report.admissions).toBe(receipts.length);
  expect(report.coverage).toMatchObject({ complete: true, omissions: [] });
  const rows = report.rows.filter((row) => row.name === "release-notes");
  const winners = rows.filter((row) => row.origin === "project-agents");
  const loser = rows.filter((row) => row.origin === "user-agents");
  // One row per generation of the winning source; the edit starts a new one.
  expect(winners.map((row) => row.counts.loaded)).toEqual([2, 1]);
  expect(winners.map((row) => row.reasons)).toEqual([
    { "loaded:named-in-task": 1, "loaded:session-active": 1 },
    { "loaded:session-active": 1 },
  ]);
  // The shadowed user copy is discovered and shadowed on every admission and never loaded.
  expect(loser.reduce((sum, row) => sum + row.counts.shadowed, 0)).toBe(receipts.length);
  expect(loser.every((row) => row.counts.loaded === 0 && row.body.count === 0)).toBe(true);
  // Contributions agree exactly with the stored receipts.
  const routes = receipts.flatMap((event) =>
    event.kind === "instructions.resolved" ? (event.payload.skills?.routes ?? []) : [],
  );
  const text = `${BODY}\n`;
  expect(winners[0]?.body).toEqual({
    count: 2,
    bytes:
      2 *
      new TextEncoder().encode(
        `---\nname: "release-notes"\ndescription: "Draft release notes."\n---\n${text}`,
      ).byteLength,
    tokens: (routes[0]?.tokens ?? 0) + (routes[1]?.tokens ?? 0),
    unestimated: 0,
  });
  expect(routes[0]?.tokens).toBe(
    estimatePromptTokens(
      `---\nname: "release-notes"\ndescription: "Draft release notes."\n---\n${text}`,
    ),
  );
  expect(winners.flatMap((row) => [row.listing.count, row.listing.unestimated])).toEqual([
    2, 0, 1, 0,
  ]);

  const human = cli([]);
  expect(human.exitCode, human.stderr).toBe(0);
  expect(human.stdout).toContain("(complete window)");
  expect(human.stdout).toContain("not provider-measured");
  for (const output of [json.stdout, human.stdout]) {
    expect(output).not.toContain("USER_COPY_NEVER_LOADED");
    expect(output).not.toContain(BODY);
  }
  return { product, report, events, cli };
}
