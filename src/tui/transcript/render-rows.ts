/**
 * Turn measured transcript rows into render entries (#622).
 *
 * When the selected expanded body is fully visible and the transcript holds
 * focus, consecutive wrapped content rows collapse into one OpenTUI textarea so
 * native range selection spans the disclosed body. Partially clipped bodies stay
 * on `Line` rows until the whole body is on screen.
 */

import type { TranscriptRow } from "./rows.ts";

export type TranscriptRenderEntry =
  | { readonly kind: "row"; readonly row: TranscriptRow }
  | {
      readonly kind: "body";
      readonly key: string;
      readonly text: string;
      readonly height: number;
      readonly focused: boolean;
    };

export type SelectableTranscriptBody = {
  readonly key: string;
  readonly text: string;
  readonly contentLines: number;
};

export function entriesForVisibleRows(
  rows: readonly TranscriptRow[],
  selectable: SelectableTranscriptBody | null,
  bodyFocused: boolean,
): readonly TranscriptRenderEntry[] {
  if (selectable === null || !bodyFocused) {
    return rows.map((row) => ({ kind: "row", row }));
  }

  const prefix = `${selectable.key}:content:`;
  const entries: TranscriptRenderEntry[] = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index];
    if (row === undefined) {
      break;
    }
    if (row.kind === "text" && row.key.startsWith(prefix)) {
      const group: TranscriptRow[] = [row];
      let next = index + 1;
      while (next < rows.length) {
        const candidate = rows[next];
        if (candidate?.kind !== "text" || !candidate.key.startsWith(prefix)) {
          break;
        }
        group.push(candidate);
        next += 1;
      }
      const firstLine = contentLineIndex(row.key);
      const last = group.at(-1);
      const lastLine = last === undefined ? -1 : contentLineIndex(last.key);
      const contiguous = lastLine - firstLine + 1 === group.length;
      const fullyVisible =
        contiguous && firstLine === 0 && lastLine === selectable.contentLines - 1;
      if (fullyVisible) {
        entries.push({
          kind: "body",
          key: row.key,
          text: selectable.text,
          height: group.length,
          focused: bodyFocused,
        });
        index = next;
        continue;
      }
    }
    entries.push({ kind: "row", row });
    index += 1;
  }
  return entries;
}

export function contentLineCount(rows: readonly TranscriptRow[], blockKey: string): number {
  const prefix = `${blockKey}:content:`;
  return rows.filter((row) => row.kind === "text" && row.key.startsWith(prefix)).length;
}

function contentLineIndex(key: string): number {
  const match = key.match(/:content:\d+:(\d+)$/);
  if (match === null) {
    return -1;
  }
  return Number(match[1]);
}
