/**
 * `AGENTS.md` and `CLAUDE.md` must not drift apart.
 *
 * They are the same guidance addressed to two tools, and they differ by exactly
 * one line: each names its own filename. Everything else being identical is a
 * property, not a coincidence — an agent that read the stale copy would follow
 * guidance this repository no longer holds.
 *
 * Nothing enforced that. Both files were edited repeatedly and stayed in step
 * only because someone remembered. This is the check that makes forgetting a
 * failure instead of a silent divergence.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** The one line that is allowed to differ, and what it must say in each file. */
const SELF_REFERENCE = {
  "AGENTS.md": "- Read the applicable global `AGENTS.md` first, then read and apply this",
  "CLAUDE.md": "- Read the applicable global `CLAUDE.md` first, then read and apply this",
} as const;

const agents = (await readFile(join(ROOT, "AGENTS.md"), "utf8")).split("\n");
const claude = (await readFile(join(ROOT, "CLAUDE.md"), "utf8")).split("\n");
const problems: string[] = [];

if (agents.length !== claude.length) {
  problems.push(
    `line counts differ: AGENTS.md has ${agents.length}, CLAUDE.md has ${claude.length}`,
  );
}

for (let index = 0; index < Math.min(agents.length, claude.length); index += 1) {
  const agentLine = agents[index] ?? "";
  const claudeLine = claude[index] ?? "";
  if (agentLine === claudeLine) {
    continue;
  }
  const isSelfReference =
    agentLine === SELF_REFERENCE["AGENTS.md"] && claudeLine === SELF_REFERENCE["CLAUDE.md"];
  if (!isSelfReference) {
    problems.push(
      `line ${index + 1} differs beyond the self-reference:\n    AGENTS.md: ${agentLine}\n    CLAUDE.md: ${claudeLine}`,
    );
  }
}

if (problems.length > 0) {
  console.error(`AGENTS.md and CLAUDE.md diverged (${problems.length}):`);
  for (const problem of problems) {
    console.error(`  ${problem}`);
  }
  process.exit(1);
}

console.log(`AGENTS.md and CLAUDE.md agree across ${agents.length} lines`);
