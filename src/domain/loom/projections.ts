/** Pure byte projection algorithms used by Loom retrieval. */

import type { ArtifactEncoding, ContentDigest } from "../artifact.ts";
import type { ContentHasherPort } from "../blob.ts";
import type { LoomError, LoomMember, LoomOmission, LoomSearchHit } from "../loom.ts";
import type { Result } from "../result.ts";
import { err, ok } from "../result.ts";

export type LoomByteProjection = {
  readonly text: string;
  readonly offset: number;
  readonly byteLength: number;
  readonly complete: boolean;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

export function hashLoomBytes(hasher: ContentHasherPort, bytes: Uint8Array): ContentDigest {
  const hash = hasher.create();
  hash.update(bytes);
  return hash.digest();
}

export function loomGroupRecoverable(members: readonly LoomMember[]): boolean {
  return members.every((member) => !member.required || member.availability === "available");
}

export function projectLoomExact(
  bytes: Uint8Array,
  maxBytes: number,
): Result<LoomByteProjection, LoomError> {
  if (bytes.byteLength > maxBytes) {
    return err(loomError("oversized", "source"));
  }
  return ok({
    text: decoder.decode(bytes),
    offset: 0,
    byteLength: bytes.byteLength,
    complete: true,
  });
}

export function projectLoomRange(
  bytes: Uint8Array,
  offsetInput: number | undefined,
  lengthInput: number | undefined,
  maxBytes: number,
): Result<LoomByteProjection, LoomError> {
  const offset = offsetInput ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.byteLength) {
    return err(loomError("malformed", "offset"));
  }
  const remaining = bytes.byteLength - offset;
  const requested = lengthInput === undefined ? Math.min(remaining, maxBytes) : lengthInput;
  if (!Number.isSafeInteger(requested) || requested < 0) {
    return err(loomError("malformed", "length"));
  }
  if (requested > remaining) {
    return err(loomError("oversized", "length"));
  }
  if (lengthInput === undefined && remaining > maxBytes) {
    return err(loomError("oversized", "source"));
  }
  if (requested > maxBytes) {
    return err(loomError("oversized", "length"));
  }
  const sliced = sliceUtf8(bytes, offset, requested);
  return ok({
    text: decoder.decode(sliced),
    offset,
    byteLength: sliced.byteLength,
    complete: offset === 0 && sliced.byteLength === bytes.byteLength,
  });
}

export function projectLoomHeadTail(
  bytes: Uint8Array,
  headBytes: number,
  tailBytes: number,
  maxBytes: number,
): Result<LoomByteProjection & { readonly omissions: readonly LoomOmission[] }, LoomError> {
  if (headBytes + tailBytes > maxBytes) {
    return err(loomError("oversized", "projection"));
  }
  if (bytes.byteLength <= headBytes + tailBytes) {
    const full = projectLoomExact(bytes, maxBytes);
    if (!full.ok) {
      return full;
    }
    return ok({ ...full.value, omissions: [] });
  }
  const head = sliceUtf8(bytes, 0, headBytes);
  const tailOffset = bytes.byteLength - tailBytes;
  const tail = sliceUtf8(bytes, tailOffset, tailBytes);
  const omitted = bytes.byteLength - head.byteLength - tail.byteLength;
  const marker = `\n… ${omitted} bytes omitted …\n`;
  const text = `${decoder.decode(head)}${marker}${decoder.decode(tail)}`;
  return ok({
    text,
    offset: 0,
    byteLength: encoder.encode(text).byteLength,
    complete: false,
    omissions: [{ kind: "bytes", count: omitted }],
  });
}

export function projectLoomSearchHits(
  bytes: Uint8Array,
  encoding: ArtifactEncoding,
  query: string,
  maxHits: number,
  contextBytes: number,
  maxBytes: number,
): Result<
  LoomByteProjection & {
    readonly omissions: readonly LoomOmission[];
    readonly hits: readonly LoomSearchHit[];
  },
  LoomError
> {
  if (encoding !== "identity") {
    return err(loomError("unsupported", "encoding"));
  }
  const text = decoder.decode(bytes);
  const hits: LoomSearchHit[] = [];
  let from = 0;
  let capped = 0;
  while (from < text.length) {
    const index = text.indexOf(query, from);
    if (index === -1) {
      break;
    }
    if (hits.length >= maxHits) {
      capped += 1;
      from = index + query.length;
      continue;
    }
    const start = byteOffsetOf(text, index);
    const contextStart = Math.max(0, start - contextBytes);
    const matchBytes = encoder.encode(query).byteLength;
    const contextLength = start - contextStart + matchBytes + contextBytes;
    const excerptBytes = sliceUtf8(bytes, contextStart, contextLength);
    hits.push({
      offset: start,
      byteLength: matchBytes,
      text: decoder.decode(excerptBytes),
    });
    from = index + query.length;
  }
  if (hits.length === 0) {
    return err(loomError("empty", "query"));
  }
  const rendered = hits.map((hit) => hit.text).join("\n---\n");
  if (encoder.encode(rendered).byteLength > maxBytes) {
    return err(loomError("oversized", "projection"));
  }
  const omissions: LoomOmission[] = capped > 0 ? [{ kind: "hits-capped", count: capped }] : [];
  return ok({
    text: rendered,
    offset: hits[0]?.offset ?? 0,
    byteLength: encoder.encode(rendered).byteLength,
    complete: false,
    omissions,
    hits,
  });
}

function loomError(code: LoomError["code"], field: string | null): LoomError {
  return { kind: "loom", code, field };
}

function utf8LeadLength(lead: number): number {
  if ((lead & 0b1000_0000) === 0) {
    return 1;
  }
  if ((lead & 0b1110_0000) === 0b1100_0000) {
    return 2;
  }
  if ((lead & 0b1111_0000) === 0b1110_0000) {
    return 3;
  }
  if ((lead & 0b1111_1000) === 0b1111_0000) {
    return 4;
  }
  return 1;
}

function sliceUtf8(bytes: Uint8Array, offset: number, length: number): Uint8Array {
  let end = Math.min(bytes.byteLength, offset + length);
  while (end > offset) {
    const previous = bytes[end - 1];
    if (previous === undefined || (previous & 0b1100_0000) !== 0b1000_0000) {
      break;
    }
    end -= 1;
  }
  const lead = end > offset ? bytes[end - 1] : undefined;
  if (lead !== undefined && end - 1 + utf8LeadLength(lead) > offset + length) {
    end -= 1;
  }
  return bytes.subarray(offset, end);
}

function byteOffsetOf(text: string, charIndex: number): number {
  return encoder.encode(text.slice(0, charIndex)).byteLength;
}
