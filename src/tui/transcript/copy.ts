/**
 * Copy a transcript pick to the clipboard (#623).
 *
 * Same pick order as include. Focus stays on the transcript after copy.
 */

import {
  blockKey,
  type NativeTranscriptRange,
  pickTranscriptCopyIdentity,
  resolveTranscriptPick,
  type TranscriptBlock,
} from "../../presentation/index.ts";
import { type CopyTextPort, type CopyTextResult, copyText } from "../clipboard.ts";

export type TranscriptCopyRequest = {
  readonly selected: string | null;
  readonly expanded: ReadonlySet<string>;
  readonly blocks: readonly TranscriptBlock[];
  readonly nativeRange?: NativeTranscriptRange | null;
  readonly port: CopyTextPort;
  readonly digestRange: (text: string) => string;
};

export function copyTranscriptBody(request: TranscriptCopyRequest): CopyTextResult {
  if (request.selected === null) {
    return { ok: false, reason: "There is no entry to copy." };
  }
  const block = request.blocks.find((item) => blockKey(item.anchor) === request.selected) ?? null;
  if (block === null) {
    return { ok: false, reason: "There is no entry to copy." };
  }
  const pick = resolveTranscriptPick(
    block,
    request.expanded.has(request.selected),
    request.nativeRange ?? null,
    request.digestRange,
  );
  if (!pick.ok) {
    return { ok: false, reason: pick.reason };
  }
  return copyText(pick.text, request.port);
}

export function copyTranscriptIdentity(request: {
  readonly selected: string | null;
  readonly blocks: readonly TranscriptBlock[];
  readonly port: CopyTextPort;
}): CopyTextResult {
  if (request.selected === null) {
    return { ok: false, reason: "There is no entry to copy." };
  }
  const block = request.blocks.find((item) => blockKey(item.anchor) === request.selected) ?? null;
  if (block === null) {
    return { ok: false, reason: "There is no entry to copy." };
  }
  const pick = pickTranscriptCopyIdentity(block);
  if (!pick.ok) {
    return { ok: false, reason: pick.reason };
  }
  return copyText(pick.text, request.port);
}
