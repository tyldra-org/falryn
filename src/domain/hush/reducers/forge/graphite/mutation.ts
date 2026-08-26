import type { HushGraphiteCommand } from "../../../command/graphite.ts";
import { stripAnsi } from "../../shared/text.ts";

/** Compact only complete, recognized Graphite mutation transcripts. */
export function formatGraphiteMutation(
  command: Exclude<HushGraphiteCommand, "log" | "submit">,
  text: string,
): string | null {
  const lines = normalizedLines(text);
  if (lines.length === 0) {
    return "";
  }
  switch (command) {
    case "sync":
      return formatSync(lines);
    case "restack":
      return formatRestack(lines);
    case "create":
      return formatCreate(lines);
    case "branch":
      return formatBranch(lines);
  }
}

function formatSync(lines: readonly string[]): string | null {
  const facts: string[] = [];
  for (const line of lines) {
    if (
      [
        "Fetching latest changes from remote...",
        "Cleaning up merged branches...",
        "Restacking branches...",
      ].some((message) => line.endsWith(message))
    ) {
      continue;
    }
    const current = /^(.+) is up to date\.$/u.exec(line)?.[1];
    if (current !== undefined) {
      facts.push(`sync ${current} up to date`);
      continue;
    }
    const deleted = /^Deleted (.+?) \(PR #(\d+) was merged\)\.$/u.exec(line);
    if (deleted !== null) {
      facts.push(`deleted ${deleted[1]} (#${deleted[2]} merged)`);
      continue;
    }
    const restacked = restackFact(line);
    if (restacked !== null) {
      facts.push(restacked);
      continue;
    }
    return null;
  }
  return facts.length === 0 ? null : facts.join("\n");
}

function formatRestack(lines: readonly string[]): string | null {
  const facts = lines.filter((line) => !line.endsWith("Restacking branches...")).map(restackFact);
  return facts.length > 0 && facts.every((fact): fact is string => fact !== null)
    ? facts.join("\n")
    : null;
}

function restackFact(line: string): string | null {
  const match = /^Restacked (.+?) on (.+?)\.$/u.exec(line);
  return match === null ? null : `restacked ${match[1]} -> ${match[2]}`;
}

function formatCreate(lines: readonly string[]): string | null {
  const facts: string[] = [];
  for (const line of lines) {
    const created = /^Created branch (.+?) on (.+?)\.$/u.exec(line);
    if (created !== null) {
      facts.push(`created ${created[1]} -> ${created[2]}`);
      continue;
    }
    const commit = /^\[(.+?) ([0-9a-f]{7,40})\] (.+)$/iu.exec(line);
    if (commit !== null) {
      facts.push(`${commit[2]} ${commit[3]}`);
      continue;
    }
    const summary =
      /^\s*(\d+) files? changed, (\d+) insertions?\(\+\), (\d+) deletions?\(-\)$/u.exec(line);
    if (summary !== null) {
      facts.push(`${summary[1]} files +${summary[2]} -${summary[3]}`);
      continue;
    }
    return null;
  }
  return facts.some((fact) => fact.startsWith("created ")) ? facts.join("\n") : null;
}

function formatBranch(lines: readonly string[]): string | null {
  const branches = lines.map((line) => {
    const graphite = /^([◉◯])\s+(.+?)(?:\s+\(current\))?$/u.exec(line);
    if (graphite !== null) {
      return `${graphite[1] === "◉" || line.includes("(current)") ? "*" : " "} ${graphite[2]}`;
    }
    const git = /^(\*|\s)\s*(\S.*)$/u.exec(line);
    return git === null ? null : `${git[1] === "*" ? "*" : " "} ${git[2]}`;
  });
  return branches.every((branch): branch is string => branch !== null) ? branches.join("\n") : null;
}

function normalizedLines(text: string): readonly string[] {
  return stripAnsi(text)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}
