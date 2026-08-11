/**
 * The vendored skill trees must stay identical.
 *
 * Two tools read two different directories, so the same content is committed
 * twice. Two hand-maintained copies drift — the interesting question is only
 * when. This turns that drift into a failed check rather than an agent that
 * behaves differently depending on which tool opened the repository.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const TREES = [".agents/skills", ".claude/skills"] as const;

async function filesUnder(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort();
}

// Named rather than indexed: `noUncheckedIndexedAccess` is on, and a tuple
// read through an index is worth neither the assertion nor the doubt.
const [AGENTS_TREE, CLAUDE_TREE] = TREES;

const agentFiles = await filesUnder(join(ROOT, AGENTS_TREE));
const claudeFiles = await filesUnder(join(ROOT, CLAUDE_TREE));
const problems: string[] = [];

for (const path of new Set([...agentFiles, ...claudeFiles])) {
  const inAgents = agentFiles.includes(path);
  const inClaude = claudeFiles.includes(path);
  if (!inAgents || !inClaude) {
    problems.push(`${path}: present only in ${inAgents ? AGENTS_TREE : CLAUDE_TREE}`);
    continue;
  }
  const agentText = await readFile(join(ROOT, AGENTS_TREE, path), "utf8");
  const claudeText = await readFile(join(ROOT, CLAUDE_TREE, path), "utf8");
  if (agentText !== claudeText) {
    problems.push(`${path}: contents differ between ${AGENTS_TREE} and ${CLAUDE_TREE}`);
  }
}

if (problems.length > 0) {
  console.error(`vendored skill trees diverged (${problems.length}):`);
  for (const problem of problems) {
    console.error(`  ${problem}`);
  }
  process.exit(1);
}

console.log(`vendored skill trees verified for ${agentFiles.length} files`);
