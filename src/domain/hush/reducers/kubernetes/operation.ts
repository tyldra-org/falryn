/** Complete Kubernetes/OpenShift operation and describe projections. */

import { parseKubernetesCommand } from "../../command/kubernetes.ts";
import { shortestText } from "../shared/text.ts";
import { kubernetesLines } from "./shared.ts";
import { formatKubernetesAlignedTable } from "./table.ts";

const RESOURCE_OUTCOME =
  /^(\S+)\s+(created|configured|unchanged|deleted|patched|labeled|annotated|scaled|restarted)$/u;
const QUOTED_RESOURCE_OUTCOME =
  /^(\S+)\s+"([^"]+)"\s+(created|configured|deleted|patched|labeled|annotated|scaled|restarted)$/u;
const ROLLOUT_OUTCOME = /^(\S+)(?:\s+"([^"]+)")?\s+successfully rolled out$/u;

export function formatKubernetesOperationOutput(
  text: string,
  commandTokens: readonly string[],
): string | null {
  const command = parseKubernetesCommand(commandTokens);
  if (command === null) return null;
  if (command.verb === "describe") return formatDescribe(text);
  if (command.executable === "oc" && command.verb === "adm" && command.subcommand === "top") {
    return formatKubernetesAlignedTable(text);
  }
  if (
    ["annotate", "apply", "create", "delete", "label", "patch", "rollout", "scale", "set"].includes(
      command.verb,
    )
  ) {
    return formatResourceOutcomes(text);
  }
  return null;
}

function formatResourceOutcomes(text: string): string | null {
  const outcomes: Array<Readonly<{ resource: string; status: string }>> = [];
  for (const line of kubernetesLines(text)) {
    const direct = RESOURCE_OUTCOME.exec(line);
    if (direct !== null) {
      outcomes.push({ resource: direct[1] ?? "", status: direct[2] ?? "" });
      continue;
    }
    const quoted = QUOTED_RESOURCE_OUTCOME.exec(line);
    if (quoted !== null) {
      outcomes.push({ resource: `${quoted[1]}/${quoted[2]}`, status: quoted[3] ?? "" });
      continue;
    }
    const rollout = ROLLOUT_OUTCOME.exec(line);
    if (rollout !== null) {
      const kind = rollout[1] ?? "";
      const resource = rollout[2] === undefined ? kind : `${kind}/${rollout[2]}`;
      outcomes.push({ resource, status: "rolled-out" });
      continue;
    }
    return null;
  }
  if (outcomes.length === 0) return null;
  const grouped = new Map<string, string[]>();
  for (const outcome of outcomes) {
    const resources = grouped.get(outcome.status) ?? [];
    resources.push(outcome.resource);
    grouped.set(outcome.status, resources);
  }
  const formatted = [...grouped]
    .map(([status, resources]) => `${status} ${resources.join(",")}`)
    .join("; ");
  return shortestText(text, formatted);
}

function formatDescribe(text: string): string | null {
  const trailingNewline = text.endsWith("\n");
  const output: string[] = [];
  let blank = false;
  let previousField: Readonly<{ depth: number; key: string }> | null = null;
  for (const line of kubernetesLines(text)) {
    if (line.length === 0) {
      blank = output.length > 0;
      continue;
    }
    if (blank) {
      output.push("");
      blank = false;
    }
    const leading = /^ */u.exec(line)?.[0].length ?? 0;
    if (leading % 2 !== 0) return null;
    const content = line.trimStart();
    const field = /^([^:]{1,40}):(?:\s+(.*)|$)/u.exec(content);
    const depth = leading / 2;
    if (field !== null) {
      const key = field[1] ?? "";
      const value = field[2] ?? "";
      output.push(`${">".repeat(depth)}${key}${value.length === 0 ? "" : `=${value}`}`);
      previousField = { depth, key };
      continue;
    }
    const previous = previousField;
    const continuation =
      previous !== null &&
      (previous.key === "Labels" || previous.key === "Annotations") &&
      /^[\w./-]+=\S/u.test(content);
    output.push(`${">".repeat(continuation ? previous.depth + 1 : depth)}${content}`);
    if (!continuation) previousField = null;
  }
  if (output.length === 0) return null;
  const formatted = output.join("\n");
  return shortestText(text, trailingNewline ? `${formatted}\n` : formatted);
}
