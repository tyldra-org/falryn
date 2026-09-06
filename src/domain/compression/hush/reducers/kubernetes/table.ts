/** Complete, uncapped Kubernetes and OpenShift table projections. */

import {
  hasCallerOwnedKubernetesOutput,
  parseKubernetesCommand,
} from "../../invocation/kubernetes.ts";
import { shortestText } from "../shared/text.ts";
import { formatAlignedTable } from "../table/format.ts";
import { kubernetesLines } from "./shared.ts";

const HEADER_ALIASES: Readonly<Record<string, string>> = {
  "CLUSTER-IP": "CLUSTER",
  "EXTERNAL-IP": "EXTERNAL",
  NAMESPACE: "NS",
  RESTARTS: "RESTART",
};

export function formatKubernetesTableOutput(
  text: string,
  commandTokens: readonly string[],
): string | null {
  const command = parseKubernetesCommand(commandTokens);
  if (command === null || hasCallerOwnedKubernetesOutput(commandTokens)) return null;
  if (command.executable === "oc" && command.verb === "status") {
    return formatOpenShiftStatus(text);
  }
  if (!["get", "pods", "services"].includes(command.verb)) return null;
  return formatKubernetesAlignedTable(text);
}

export function formatKubernetesAlignedTable(text: string): string | null {
  const empty = formatNoResources(text);
  if (empty !== null) return empty;
  const formatted = formatAlignedTable(text);
  if (formatted === null) return null;
  const trailingNewline = formatted.endsWith("\n");
  const rows = formatted.split("\n");
  if (trailingNewline) rows.pop();
  const header = rows[0]?.split("\t");
  if (header === undefined) return null;
  rows[0] = header.map((cell) => HEADER_ALIASES[cell] ?? cell).join("\t");
  const result = rows.join("\n");
  return shortestText(text, trailingNewline ? `${result}\n` : result);
}

function formatNoResources(text: string): string | null {
  const line = text.trim();
  if (line === "No resources found.") return "none";
  const namespaced = /^No resources found in (\S+) namespace\.$/u.exec(line);
  return namespaced === null ? null : `none ns=${namespaced[1]}`;
}

function formatOpenShiftStatus(text: string): string | null {
  const lines = kubernetesLines(text);
  const heading = /^In project (.+) on server (\S+)$/u.exec(lines[0] ?? "");
  if (heading === null) return null;
  const output = [`project ${heading[1]} @ ${heading[2]}`];
  for (const line of lines.slice(1)) {
    if (line.length === 0) continue;
    const detail = /^View details with '([^']+)' or list everything with '([^']+)'\.$/u.exec(
      line.trim(),
    );
    if (detail !== null) {
      output.push(`details '${detail[1]}'; all '${detail[2]}'`);
      continue;
    }
    const leading = /^ */u.exec(line)?.[0].length ?? 0;
    if (leading % 2 !== 0) return null;
    output.push(`${">".repeat(leading / 2)}${line.trimStart()}`);
  }
  return shortestText(text, output.join("\n"));
}
