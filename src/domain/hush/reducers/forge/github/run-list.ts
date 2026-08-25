import { numberField, parseJson, records, stateWord, stringField } from "./json.ts";

type RunRow = Readonly<{
  id: number;
  name: string;
  state: string;
}>;

export function formatGithubRunList(text: string): string | null {
  const json = parseJson(text);
  if (json !== null) {
    const entries = records(json);
    if (entries === null) {
      return null;
    }
    if (entries.length === 0) {
      return "";
    }
    const rows = entries.map((entry) => {
      const id = numberField(entry, "databaseId");
      const name = stringField(entry, "workflowName") ?? stringField(entry, "name");
      const status = stringField(entry, "status");
      const conclusion = stringField(entry, "conclusion") ?? "";
      return id === null || name === null || status === null
        ? null
        : { id, name, state: runState(status, conclusion) };
    });
    return rows.every((row): row is RunRow => row !== null) ? formatRows(rows) : null;
  }
  return formatNativeRunList(text);
}

function formatNativeRunList(text: string): string | null {
  const lines = text.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) {
    return "";
  }
  const rows = lines.map((line) => {
    const fields = line.split("\t");
    if (fields.length !== 9) {
      return null;
    }
    const [status, conclusion, , name, , , id] = fields;
    return status && conclusion !== undefined && name && id && /^\d+$/u.test(id)
      ? { id: Number(id), name, state: runState(status, conclusion) }
      : null;
  });
  return rows.every((row): row is RunRow => row !== null) ? formatRows(rows) : null;
}

/** Factor repeated workflow and state labels without reordering or dropping a run. */
function formatRows(rows: readonly RunRow[]): string {
  const chunks: string[] = [];
  for (let start = 0; start < rows.length; ) {
    const name = rows[start]?.name;
    let end = start + 1;
    while (end < rows.length && rows[end]?.name === name) {
      end += 1;
    }
    const group = rows.slice(start, end);
    chunks.push(shortest(plainRunRows(group), groupedRunRows(group)));
    start = end;
  }
  return chunks.join("\n");
}

function plainRunRows(rows: readonly RunRow[]): string {
  return rows.map((row) => `${row.state} ${row.id} ${row.name}`).join("\n");
}

function groupedRunRows(rows: readonly RunRow[]): string {
  const name = rows[0]?.name;
  if (name === undefined || rows.length < 2 || /[\r\n]/u.test(name)) {
    return plainRunRows(rows);
  }
  const states: string[] = [];
  for (let start = 0; start < rows.length; ) {
    const state = rows[start]?.state;
    let end = start + 1;
    while (end < rows.length && rows[end]?.state === state) {
      end += 1;
    }
    states.push(
      `${state} ${rows
        .slice(start, end)
        .map((row) => row.id)
        .join(" ")}`,
    );
    start = end;
  }
  return `${name}:\n${states.join("\n")}`;
}

function shortest(first: string, second: string): string {
  return byteLength(second) < byteLength(first) ? second : first;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function runState(status: string, conclusion: string): string {
  const normalizedConclusion = conclusion.toLowerCase();
  const normalizedStatus = status.toLowerCase();
  if (normalizedConclusion === "success") {
    return "ok";
  }
  if (["cancelled", "canceled"].includes(normalizedConclusion)) {
    return "cancel";
  }
  if (normalizedConclusion === "skipped") {
    return "skip";
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
