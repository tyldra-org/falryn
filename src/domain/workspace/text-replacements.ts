/**
 * Evidence-bound text replacements (#996). A model names exact old and new text inside
 * files it has machine-issued Read or Search evidence for; this owner finds each exact
 * match inside that evidence's covered bytes and lowers the result to native patch hunks.
 * It never fuzzy-matches, relocates text or computes anything the model must repeat.
 * Every lowering is checked by replaying the hunks through the native hunk applier:
 * if the result is not exactly the requested text, the request is refused.
 */
import { z } from "zod";
import { err, ok, type Result } from "../foundation/result.ts";
import {
  applyPatchHunks,
  DEFAULT_MAX_PATCH_HUNK_LINES,
  DEFAULT_MAX_PATCH_HUNKS,
  DEFAULT_MAX_PATCH_TARGETS,
  joinPatchedLines,
  type ParsedPatchHunk,
} from "./workspace-patch.ts";
import { decodeWorkspaceText, detectNewline, isBinaryText, splitLines } from "./workspace-read.ts";

export const TEXT_REPLACEMENT_LIMITS = Object.freeze({
  /** The native patch plan's default target limit, so a prepared plan always parses. */
  targets: DEFAULT_MAX_PATCH_TARGETS,
  replacementsPerTarget: 32,
  dependencies: DEFAULT_MAX_PATCH_TARGETS,
  /** Native hunks across the whole request. */
  hunks: DEFAULT_MAX_PATCH_HUNKS,
  hunkLines: DEFAULT_MAX_PATCH_HUNK_LINES,
  textLength: 65_536,
  /** Occurrences scanned for one old text before the request is refused as too broad. */
  occurrences: 4_096,
});

const itemId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u, "item-id-invalid");
const evidenceRef = z
  .string()
  .regex(/^resource-evidence-[A-Za-z0-9-]{1,128}$/u, "evidence-ref-invalid");
const text = (minimum: number) =>
  z
    .string()
    .min(minimum)
    .max(TEXT_REPLACEMENT_LIMITS.textLength)
    .refine((value) => !value.includes("\0"), "text-nul");

export const textReplacementSchema = z.strictObject({
  itemId,
  oldText: text(1),
  newText: text(0),
  replaceAll: z.boolean().default(false),
});
export const textReplacementsInputSchema = z
  .strictObject({
    version: z.literal(1),
    kind: z.literal("text-replacements"),
    /**
     * exact-revision: the evidence must still describe the current file. covered-ranges:
     * the file may have changed elsewhere, but every byte range the evidence covered must
     * be unchanged at its original offset.
     */
    freshness: z.enum(["exact-revision", "covered-ranges"]).default("exact-revision"),
    targets: z
      .array(
        z.strictObject({
          itemId,
          evidenceRef,
          replacements: z
            .array(textReplacementSchema)
            .min(1)
            .max(TEXT_REPLACEMENT_LIMITS.replacementsPerTarget),
        }),
      )
      .min(1)
      .max(TEXT_REPLACEMENT_LIMITS.targets),
    /** Read-only files the edit relies on; any change refuses the plan up to apply. */
    dependencies: z
      .array(z.strictObject({ itemId, evidenceRef }))
      .max(TEXT_REPLACEMENT_LIMITS.dependencies)
      .default([]),
  })
  .superRefine((value, context) => {
    const ids = [
      ...value.targets.flatMap((target) => [
        target.itemId,
        ...target.replacements.map((item) => item.itemId),
      ]),
      ...value.dependencies.map((item) => item.itemId),
    ];
    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: "custom", message: "item-id-duplicate", path: ["targets"] });
  });
export type TextReplacementsInput = z.infer<typeof textReplacementsInputSchema>;
export type TextReplacement = z.infer<typeof textReplacementSchema>;

export type TextReplacementError =
  | { readonly code: "unsupported-fidelity"; readonly reason: string }
  | { readonly code: "no-match"; readonly itemId: string }
  /** The text exists in the file but not inside the bytes the evidence covered. */
  | { readonly code: "match-outside-evidence"; readonly itemId: string }
  | { readonly code: "ambiguous-match"; readonly itemId: string; readonly matches: number }
  | { readonly code: "replace-all-needs-complete-evidence"; readonly itemId: string }
  | { readonly code: "overlapping-replacements"; readonly itemIds: readonly [string, string] }
  | { readonly code: "match-splits-line-break"; readonly itemId: string }
  | { readonly code: "replacement-limit"; readonly limit: "hunks" | "hunk-lines" | "occurrences" }
  | { readonly code: "unrepresentable-replacement" };

export type ByteRange = { readonly offset: number; readonly length: number };

export type LoweredReplacements = {
  /** Native hunks ordered by line; hunk IDs name the replacement items they carry. */
  readonly hunks: readonly {
    readonly hunkId: string;
    readonly oldStart: number;
    readonly oldLines: readonly string[];
    readonly newLines: readonly string[];
  }[];
  readonly items: readonly {
    readonly itemId: string;
    readonly matches: number;
    /** 1-based inclusive original line spans of each replaced occurrence. */
    readonly lines: readonly { readonly start: number; readonly end: number }[];
  }[];
  /** complete-file when the evidence covered every byte; otherwise uniqueness is scoped. */
  readonly scope: "complete-file" | "covered-ranges";
};

/** UTF-16 offset of every UTF-8 byte boundary; -1 inside a multi-byte sequence. */
function byteToChar(text: string, prefix: number): Int32Array {
  const bytes = new TextEncoder().encode(text).byteLength + prefix;
  const map = new Int32Array(bytes + 1).fill(-1);
  let byte = prefix;
  let index = 0;
  for (let at = 0; at < prefix; at++) map[at] = 0;
  for (const character of text) {
    map[byte] = index;
    const code = character.codePointAt(0) ?? 0;
    byte += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    index += character.length;
  }
  map[byte] = index;
  return map;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "\r" && text[index + 1] === "\n") {
      index++;
      starts.push(index + 1);
    } else if (char === "\n" || char === "\r") starts.push(index + 1);
  }
  return starts;
}
function lineOf(starts: readonly number[], position: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((starts[middle] ?? 0) <= position) low = middle;
    else high = middle - 1;
  }
  return low;
}
const BREAK = /\r\n|\r|\n/u;
function body(segment: string): string[] {
  if (segment === "") return [];
  return segment.replace(/(?:\r\n|\r|\n)$/u, "").split(BREAK);
}

type Span = {
  readonly start: number;
  readonly end: number;
  readonly newText: string;
  readonly itemId: string;
};

/**
 * Lower one target's replacements over its exact bytes. Coverage is the evidence's byte
 * ranges into those bytes. Replacements all address the same original bytes.
 */
export function lowerTextReplacements(
  bytes: Uint8Array,
  coverage: readonly ByteRange[],
  replacements: readonly TextReplacement[],
): Result<LoweredReplacements, TextReplacementError> {
  const decoded = decodeWorkspaceText(bytes);
  if (!decoded.ok) return err({ code: "unsupported-fidelity", reason: "encoding" });
  if (decoded.value.encoding !== "utf-8" && decoded.value.encoding !== "utf-8-bom")
    return err({ code: "unsupported-fidelity", reason: "encoding" });
  const source = decoded.value.text;
  if (isBinaryText(source)) return err({ code: "unsupported-fidelity", reason: "binary" });
  const style = detectNewline(source);
  if (style === "mixed") return err({ code: "unsupported-fidelity", reason: "mixed-newlines" });
  const mark = style === "crlf" ? "\r\n" : style === "cr" ? "\r" : "\n";
  const prefix = decoded.value.encoding === "utf-8-bom" ? 3 : 0;

  // Covered character ranges; a range edge inside a character shrinks inward.
  const map = byteToChar(source, prefix);
  const covered: { start: number; end: number }[] = [];
  for (const range of coverage) {
    let from = Math.max(range.offset, prefix);
    let to = Math.min(range.offset + range.length, map.length - 1);
    while (from < to && (map[from] ?? -1) < 0) from++;
    while (to > from && (map[to] ?? -1) < 0) to--;
    if (to > from) covered.push({ start: map[from] ?? 0, end: map[to] ?? 0 });
  }
  covered.sort((a, b) => a.start - b.start);
  let reach = 0;
  for (const range of covered) if (range.start <= reach) reach = Math.max(reach, range.end);
  const complete = reach >= source.length && coverage.some((range) => range.offset <= prefix);
  const inside = (start: number, end: number) =>
    covered.some((range) => range.start <= start && end <= range.end);

  const spans: Span[] = [];
  const counts = new Map<string, number>();
  for (const replacement of replacements) {
    // Line breaks are written in the file's own single style; the text stays exact.
    const needle = replacement.oldText.split(BREAK).join(mark);
    const found: number[] = [];
    // Overlapping occurrences count toward ambiguity; replace-all takes disjoint ones.
    for (let at = source.indexOf(needle); at >= 0; at = source.indexOf(needle, at + 1)) {
      found.push(at);
      if (found.length > TEXT_REPLACEMENT_LIMITS.occurrences)
        return err({ code: "replacement-limit", limit: "occurrences" });
    }
    if (replacement.replaceAll) {
      if (!complete)
        return err({ code: "replace-all-needs-complete-evidence", itemId: replacement.itemId });
      if (found.length === 0) return err({ code: "no-match", itemId: replacement.itemId });
      let last = -1;
      let taken = 0;
      for (const at of found) {
        if (at < last) continue;
        spans.push({
          start: at,
          end: at + needle.length,
          newText: replacement.newText,
          itemId: replacement.itemId,
        });
        last = at + needle.length;
        taken++;
      }
      counts.set(replacement.itemId, taken);
      continue;
    }
    const scoped = found.filter((at) => inside(at, at + needle.length));
    if (scoped.length === 0)
      return err({
        code: found.length > 0 ? "match-outside-evidence" : "no-match",
        itemId: replacement.itemId,
      });
    if (scoped.length > 1)
      return err({ code: "ambiguous-match", itemId: replacement.itemId, matches: scoped.length });
    const at = scoped[0] ?? 0;
    spans.push({
      start: at,
      end: at + needle.length,
      newText: replacement.newText,
      itemId: replacement.itemId,
    });
    counts.set(replacement.itemId, 1);
  }
  spans.sort((a, b) => a.start - b.start);
  for (let index = 1; index < spans.length; index++) {
    const previous = spans[index - 1];
    const current = spans[index];
    if (previous && current && current.start < previous.end)
      return err({ code: "overlapping-replacements", itemIds: [previous.itemId, current.itemId] });
  }

  const starts = lineStarts(source);
  const lineCount = splitLines(source).length;
  type Group = { first: number; last: number; spans: Span[] };
  const groups: Group[] = [];
  const itemLines = new Map<string, { start: number; end: number }[]>();
  for (const span of spans) {
    // A match may not split a CRLF pair: native lines cannot represent half a break.
    if (
      (source[span.start] === "\n" && source[span.start - 1] === "\r") ||
      (source[span.end - 1] === "\r" && source[span.end] === "\n")
    )
      return err({ code: "match-splits-line-break", itemId: span.itemId });
    const first = lineOf(starts, span.start);
    let last = lineOf(starts, span.end - 1);
    itemLines.set(span.itemId, [
      ...(itemLines.get(span.itemId) ?? []),
      { start: first + 1, end: last + 1 },
    ]);
    // Consuming a line break joins the following line into the same hunk.
    if (/[\r\n]$/u.test(source.slice(span.start, span.end)) && last + 1 < lineCount) last++;
    const open = groups.at(-1);
    if (open && first <= open.last + 1) {
      open.last = Math.max(open.last, last);
      open.spans.push(span);
    } else groups.push({ first, last, spans: [span] });
  }
  if (groups.length > TEXT_REPLACEMENT_LIMITS.hunks)
    return err({ code: "replacement-limit", limit: "hunks" });

  const hunks: LoweredReplacements["hunks"][number][] = [];
  for (const group of groups) {
    const segmentStart = starts[group.first] ?? 0;
    const segmentEnd =
      group.last + 1 < lineCount ? (starts[group.last + 1] ?? source.length) : source.length;
    const segment = source.slice(segmentStart, segmentEnd);
    let replaced = "";
    let cursor = segmentStart;
    for (const span of group.spans) {
      replaced += source.slice(cursor, span.start) + span.newText.split(BREAK).join(mark);
      cursor = span.end;
    }
    replaced += source.slice(cursor, segmentEnd);
    const oldLines = body(segment);
    const newLines = body(replaced);
    if (Math.max(oldLines.length, newLines.length) > TEXT_REPLACEMENT_LIMITS.hunkLines)
      return err({ code: "replacement-limit", limit: "hunk-lines" });
    const ids = group.spans.map((span) => span.itemId);
    const joined = [...new Set(ids)].join("+");
    hunks.push({
      hunkId: joined.length <= 128 ? joined : `group-${hunks.length + 1}`,
      oldStart: group.first + 1,
      oldLines,
      newLines,
    });
  }

  // Replay through the native applier; anything but the exact requested text is refused.
  let expected = "";
  let cursor = 0;
  for (const span of spans) {
    expected += source.slice(cursor, span.start) + span.newText.split(BREAK).join(mark);
    cursor = span.end;
  }
  expected += source.slice(cursor);
  const parsed: ParsedPatchHunk[] = hunks.map((hunk, index) => ({
    index,
    hunkId: hunk.hunkId,
    oldStart: hunk.oldStart,
    addressDigest: null,
    oldLines: hunk.oldLines,
    newLines: hunk.newLines,
  }));
  const applied = applyPatchHunks(splitLines(source), parsed);
  const trailing = source.endsWith("\n") || source.endsWith("\r");
  if (
    !applied.ok ||
    joinPatchedLines(
      applied.value.lines,
      style === "crlf" ? "crlf" : style === "cr" ? "cr" : "lf",
      trailing,
    ) !== expected
  )
    return err({ code: "unrepresentable-replacement" });

  return ok({
    hunks,
    items: replacements.map((replacement) => ({
      itemId: replacement.itemId,
      matches: counts.get(replacement.itemId) ?? 0,
      lines: itemLines.get(replacement.itemId) ?? [],
    })),
    scope: complete ? "complete-file" : "covered-ranges",
  });
}

/** Whether every covered byte range is identical, at the same offset, in both byte sets. */
export function coveredRangesUnchanged(
  original: Uint8Array,
  current: Uint8Array,
  coverage: readonly ByteRange[],
): boolean {
  return coverage.every(({ offset, length }) => {
    if (offset + length > original.length || offset + length > current.length) return false;
    for (let index = offset; index < offset + length; index++)
      if (original[index] !== current[index]) return false;
    return true;
  });
}
