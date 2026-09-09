import type { ResourceProjection, ResourceSegment } from "../../domain/documents/resource-read.ts";
import { containsRedactableSecret } from "../diagnostics/redaction.ts";

/** Byte offsets always refer to the original UTF-8 source, never to rendered line numbers. */
export function projectResource(
  bytes: Uint8Array,
  projection: ResourceProjection,
  maximum: number,
) {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return { ok: false as const, error: { code: "unsupported-media" } };
  }
  if (text.includes("\0")) return { ok: false as const, error: { code: "unsupported-media" } };
  if (containsRedactableSecret(text)) return { ok: false as const, error: { code: "denied" } };
  const ranges: { offset: number; length: number }[] = [];
  const omissions: string[] = [];
  if (projection.kind === "lines") {
    if (projection.end < projection.start)
      return { ok: false as const, error: { code: "malformed-range" } };
    let offset = 0;
    let number = 1;
    for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/gu)) {
      if (match[0].length === 0) break;
      const length = new TextEncoder().encode(match[0]).length;
      if (number >= projection.start && number <= projection.end) {
        const previous = ranges[0];
        if (previous) previous.length += length;
        else ranges.push({ offset, length });
      }
      offset += length;
      if (number++ >= projection.end) break;
    }
    if (ranges.length === 0) return { ok: false as const, error: { code: "range-out-of-bounds" } };
  } else if (projection.kind === "ranges") ranges.push(...projection.ranges);
  else if (projection.kind === "head-tail") {
    const head = Math.min(projection.headBytes, bytes.length);
    ranges.push({ offset: 0, length: head });
    let tail = Math.max(head, bytes.length - projection.tailBytes);
    const requestedTail = tail;
    while (tail < bytes.length && ((bytes[tail] ?? 0) & 0xc0) === 0x80) tail++;
    if (tail !== requestedTail) omissions.push("utf8-boundary");
    if (tail < bytes.length) ranges.push({ offset: tail, length: bytes.length - tail });
  } else if (projection.kind === "exact") ranges.push({ offset: 0, length: bytes.length });
  else {
    let offset = 0;
    for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/gu)) {
      const line = match[0];
      if (line.length === 0) break;
      const length = new TextEncoder().encode(line).length;
      const matches =
        projection.kind === "search"
          ? line.includes(projection.query)
          : /^(?:#{1,6}\s|(?:export\s+)?(?:class|function|interface|type|const|def)\s)/u.test(line);
      if (matches) ranges.push({ offset, length });
      offset += length;
      if (ranges.length > (projection.kind === "search" ? projection.maxHits : 64)) break;
    }
  }
  const segments: ResourceSegment[] = [];
  let used = 0;
  for (const range of ranges) {
    if (range.offset + range.length > bytes.length)
      return { ok: false as const, error: { code: "range-out-of-bounds" } };
    if (segments.length >= (projection.kind === "search" ? projection.maxHits : 64)) {
      omissions.push("hit-limit");
      break;
    }
    const length = Math.min(range.length, maximum - used);
    if (length < range.length) omissions.push("output-limit");
    if (length === 0 && range.length > 0) break;
    let end = range.offset + length;
    // Never replace a split code point and then claim exact bytes.
    while (end > range.offset && end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
    try {
      const selected = decoder.decode(bytes.subarray(range.offset, end));
      segments.push({ offset: range.offset, length: end - range.offset, text: selected });
      used += end - range.offset;
    } catch {
      return { ok: false as const, error: { code: "invalid-utf8-range" } };
    }
    if (end - range.offset < range.length && !omissions.includes("output-limit"))
      omissions.push("utf8-boundary");
  }
  const complete =
    omissions.length === 0 &&
    segments.length === 1 &&
    segments[0]?.offset === 0 &&
    segments[0]?.length === bytes.length;
  if (!complete && omissions.length === 0) omissions.push("selected-ranges");
  return {
    ok: true as const,
    value: {
      segments,
      used,
      omissions,
      complete,
      fidelity: projection.kind === "outline" ? ("structural" as const) : ("exact" as const),
    },
  };
}
