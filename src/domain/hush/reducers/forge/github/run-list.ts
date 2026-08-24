import { numberField, parseJson, records, stateWord, stringField } from "./json.ts";

export function formatGithubRunList(text: string): string | null {
  const json = parseJson(text);
  if (json !== null) {
    const entries = records(json);
    if (entries === null) {
      return null;
    }
    if (entries.length === 0) {
      return "no runs";
    }
    const lines = entries.map((entry) => {
      const id = numberField(entry, "databaseId");
      const name = stringField(entry, "workflowName") ?? stringField(entry, "name");
      const status = stringField(entry, "status");
      const conclusion = stringField(entry, "conclusion") ?? "";
      return id === null || name === null || status === null
        ? null
        : `${runState(status, conclusion)} ${id} ${name}`;
    });
    return lines.every((line): line is string => line !== null) ? lines.join("\n") : null;
  }
  return formatNativeRunList(text);
}

function formatNativeRunList(text: string): string | null {
  const lines = text.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) {
    return "no runs";
  }
  const formatted = lines.map((line) => {
    const fields = line.split("\t");
    if (fields.length !== 9) {
      return null;
    }
    const [status, conclusion, , name, , , id] = fields;
    return status && conclusion !== undefined && name && id && /^\d+$/u.test(id)
      ? `${runState(status, conclusion)} ${id} ${name}`
      : null;
  });
  return formatted.every((line): line is string => line !== null) ? formatted.join("\n") : null;
}

function runState(status: string, conclusion: string): string {
  const normalizedConclusion = conclusion.toLowerCase();
  const normalizedStatus = status.toLowerCase();
  if (normalizedConclusion === "success") {
    return "ok";
  }
  if (
    ["failure", "action_required", "startup_failure", "timed_out"].includes(normalizedConclusion)
  ) {
    return "fail";
  }
  if (normalizedStatus === "in_progress") {
    return "run";
  }
  if (["queued", "requested", "waiting", "pending"].includes(normalizedStatus)) {
    return "wait";
  }
  return stateWord(normalizedConclusion || normalizedStatus || "unknown");
}
