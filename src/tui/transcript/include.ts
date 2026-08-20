/**
 * Include a transcript pick as a composer attachment (#621).
 *
 * Bytes go on the session payload port. Chrome never holds the body. Duplicate
 * identity is already-included, not a second chip.
 */

import { createTranscriptAttachment, digestBytes } from "../../application/index.ts";
import { type AttachmentDescriptor, includeTranscriptAttachment } from "../../domain/index.ts";
import {
  blockKey,
  type NativeTranscriptRange,
  resolveTranscriptPick,
  type TranscriptBlock,
} from "../../presentation/index.ts";
import { looksSecret } from "../paste.ts";

export type TranscriptIncludeDraftRequest = {
  readonly selected: string | null;
  readonly expanded: ReadonlySet<string>;
  readonly blocks: readonly TranscriptBlock[];
  readonly attachments: readonly AttachmentDescriptor[];
  readonly nextId: string;
  readonly nativeRange?: NativeTranscriptRange | null;
};

export type TranscriptIncludeDraftResult =
  | {
      readonly ok: true;
      readonly attachment: AttachmentDescriptor;
      readonly bytes: Uint8Array;
      readonly attachments: readonly AttachmentDescriptor[];
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly attachments: readonly AttachmentDescriptor[];
    };

const encoder = new TextEncoder();

function digestRange(text: string): string {
  return digestBytes(encoder.encode(text));
}

export function includeTranscriptInDraft(
  request: TranscriptIncludeDraftRequest,
): TranscriptIncludeDraftResult {
  if (request.selected === null) {
    return fail(request.attachments, "There is no entry to include.");
  }
  const block = request.blocks.find((item) => blockKey(item.anchor) === request.selected) ?? null;
  if (block === null) {
    return fail(request.attachments, "There is no entry to include.");
  }

  const pick = resolveTranscriptPick(
    block,
    request.expanded.has(request.selected),
    request.nativeRange ?? null,
    digestRange,
  );
  if (!pick.ok) {
    return fail(request.attachments, pick.reason);
  }

  const attachment = createTranscriptAttachment({
    id: request.nextId,
    blockKey: pick.blockKey,
    rangeDigest: pick.rangeDigest,
    text: pick.text,
    secret: looksSecret(pick.text),
  });
  const included = includeTranscriptAttachment(request.attachments, attachment);
  if (!included.ok) {
    return fail(included.attachments, included.reason);
  }

  return {
    ok: true,
    attachment: included.attachment,
    bytes: encoder.encode(pick.text),
    attachments: included.attachments,
  };
}

function fail(
  attachments: readonly AttachmentDescriptor[],
  reason: string,
): TranscriptIncludeDraftResult {
  return { ok: false, reason, attachments };
}
