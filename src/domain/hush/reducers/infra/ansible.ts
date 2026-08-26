/** Complete Ansible playbook projection. */

import { buildLines } from "../build/shared.ts";
import { shortestText } from "../shared/text.ts";

export function formatAnsiblePlaybook(text: string): string | null {
  const output: string[] = [];
  for (const line of buildLines(text)) {
    const heading = /^(PLAY|TASK) \[(.+)\]\s+\*+$/u.exec(line);
    if (heading !== null) {
      output.push(`${heading[1]?.toLowerCase()} ${heading[2]}`);
      continue;
    }
    if (/^PLAY RECAP\s+\*+$/u.test(line)) {
      output.push("recap");
      continue;
    }
    const hostResult = /^(ok|changed|skipping|failed|fatal): \[([^\]]+)\](?: => (.+))?$/u.exec(
      line,
    );
    if (hostResult !== null) {
      output.push(
        `${hostResult[1]} ${hostResult[2]}${hostResult[3] === undefined ? "" : ` ${hostResult[3]}`}`,
      );
      continue;
    }
    const recap =
      /^(\S+)\s*:\s*(ok=\d+\s+changed=\d+\s+unreachable=\d+\s+failed=\d+\s+skipped=\d+\s+rescued=\d+\s+ignored=\d+)$/u.exec(
        line,
      );
    if (recap !== null) {
      output.push(`${recap[1]} ${recap[2]}`);
      continue;
    }
    return null;
  }
  if (!output.includes("recap")) return null;
  return shortestText(text, output.join("\n"));
}
