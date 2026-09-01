/** npm output reduction. */

import { compactDuplicateRuns, shortestText, stripAnsi } from "../../shared/text.ts";
import { firstNonblankLine, formatDependencyTree, trimOuterBlankLines } from "./shared.ts";

export function formatNpmInstall(text: string): string | null {
  const plain = stripAnsi(text).trimEnd();
  const lines = plain.split("\n");
  const result: string[] = [];
  let changed = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (line.length === 0) {
      changed = true;
      continue;
    }
    const summary = formatNpmSummary(line);
    if (summary !== null) {
      result.push(summary);
      changed = true;
      continue;
    }
    const funding = /^(\d+) packages? (?:is|are) looking for funding$/u.exec(line);
    if (funding !== null && /^run `npm fund` for details$/u.test(lines[index + 1]?.trim() ?? "")) {
      result.push(`funding ${funding[1]}: npm fund`);
      index += 1;
      changed = true;
      continue;
    }
    const vulnerability = /^found (\d+) vulnerabilities?$/u.exec(line);
    if (vulnerability !== null) {
      result.push(`vulnerabilities ${vulnerability[1]}`);
      changed = true;
      continue;
    }
    result.push(line);
  }
  return changed ? shortestText(plain, result.join("\n")) : null;
}

export function formatNpmList(plain: string): string | null {
  return formatDependencyTree(plain, false);
}

export function formatNpmScript(text: string): string | null {
  const plain = stripAnsi(text).trimEnd();
  const lines = plain.split("\n");
  const banner = firstNonblankLine(lines);
  let changed = false;
  if (/^>\s+\S+@\S+\s+\S+(?:\s+\S+)?$/u.test(lines[banner] ?? "")) {
    lines.splice(banner, 1);
    changed = true;
    const command = lines[banner];
    if (command !== undefined && /^>\s+\S/u.test(command)) {
      lines[banner] = command.replace(/^>\s+/u, "");
    }
  }
  trimOuterBlankLines(lines);
  const formatted = compactDuplicateRuns(lines.join("\n"));
  return !changed && formatted === plain ? null : shortestText(plain, formatted);
}

function formatNpmSummary(line: string): string | null {
  const current = /^up to date, audited (\d+) packages? in (\S+)$/u.exec(line);
  if (current !== null) return `up to date; audited ${current[1]}; ${current[2]}`;
  const audit = /(?:,? and )?audited (\d+) packages? in (\S+)$/u.exec(line);
  if (audit === null) return null;
  const prefix = line.slice(0, audit.index).replace(/,\s*$/u, "");
  const operations = [...prefix.matchAll(/(?:^|,\s*)(added|removed|changed) (\d+) packages?/gu)];
  if (
    operations.length === 0 ||
    operations.map((match) => match[0]).join("").length < prefix.length
  ) {
    return null;
  }
  const signs: Readonly<Record<string, string>> = { added: "+", removed: "-", changed: "~" };
  const packages = operations.map((match) => `${signs[match[1] ?? ""]}${match[2]}`).join(" ");
  return `packages ${packages}; audited ${audit[1]}; ${audit[2]}`;
}
