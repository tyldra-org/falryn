import { numberField, parseJson, records, stringField } from "../github/json.ts";
import { singleLine } from "./fields.ts";
import { visibleGitlabState } from "./state.ts";

type MergeRequestRow = Readonly<{
  iid: number;
  title: string;
  state: string;
  source: string;
  target: string;
}>;

/** Keep every MR identity, state, and branch relation without duplicating list metadata. */
export function formatGitlabMrList(text: string, args: readonly string[] = []): string | null {
  const json = parseJson(text);
  const entries = json === null ? null : records(json);
  if (entries === null) {
    return null;
  }
  const rows = entries.map((entry) => {
    const iid = numberField(entry, "iid");
    const title = stringField(entry, "title");
    const state = stringField(entry, "state");
    const source = stringField(entry, "source_branch");
    const target = stringField(entry, "target_branch");
    if (
      iid === null ||
      title === null ||
      state === null ||
      source === null ||
      target === null ||
      [title, source, target].some((value) => singleLine(value) === null)
    ) {
      return null;
    }
    return { iid, title, state, source, target };
  });
  return rows.every((row): row is MergeRequestRow => row !== null) ? formatRows(rows, args) : null;
}

/** Factor a repeated target branch only when that is actually shorter. */
function formatRows(rows: readonly MergeRequestRow[], args: readonly string[]): string {
  const chunks: string[] = [];
  for (let start = 0; start < rows.length; ) {
    const target = rows[start]?.target;
    let end = start + 1;
    while (end < rows.length && rows[end]?.target === target) {
      end += 1;
    }
    const group = rows.slice(start, end);
    const plain = group.map((row) => `${rowBody(row, args)} -> ${row.target}`).join("\n");
    const grouped = `-> ${target}:\n${group.map((row) => rowBody(row, args)).join("\n")}`;
    chunks.push(byteLength(grouped) < byteLength(plain) ? grouped : plain);
    start = end;
  }
  return chunks.join("\n");
}

function rowBody(row: MergeRequestRow, args: readonly string[]): string {
  return `!${row.iid} ${row.source}: ${visibleGitlabState(row.state, args, "merge-request")}${row.title}`;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
