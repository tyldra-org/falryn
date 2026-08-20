/**
 * Transcript include/copy pick body (#619, #621).
 *
 * Chrome, summaries, quote bars, recap headers, and path-only headers are not
 * the body. Truncated display is never treated as the complete source. Secret
 * and redacted content refuse rather than leaking withheld text. OpenTUI native
 * range is a later child; this module does not store a Falryn-owned range.
 */

import { assertNever } from "../../domain/index.ts";
import { blockKey, type TranscriptBlock } from "./blocks.ts";
import type { BoundedText } from "./disclosure.ts";

export type TranscriptIncludePick =
  | {
      readonly ok: true;
      readonly blockKey: string;
      readonly text: string;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

type LabelledBody = {
  readonly label: string;
  readonly content: BoundedText;
};

/**
 * Body fields a pick may include. Exhaustive over kinds so a new body cannot
 * slip in as chrome, and path-only headers stay out.
 */
export function includeBodiesOf(block: TranscriptBlock): readonly LabelledBody[] {
  switch (block.kind) {
    case "user-input":
      return [{ label: "message", content: block.text }];
    case "model-text":
      return [{ label: "response", content: block.text }];
    case "model-reasoning":
      return [{ label: "reasoning", content: block.text }];
    case "model-outcome":
    case "turn-outcome":
    case "process-exit":
    case "artifact":
      return [];
    case "tool-request":
      return [{ label: "input", content: block.input }];
    case "tool-progress":
      return [{ label: "progress", content: block.note }];
    case "tool-result":
      return [{ label: "output", content: block.output }];
    case "process-stream":
      return [{ label: block.channel, content: block.output }];
    case "file-change":
      return [{ label: "detail", content: block.detail }];
    case "repository-activity":
      return [{ label: "detail", content: block.detail }];
    case "task-progress":
      return [{ label: "task", content: block.label }];
    case "notice":
      return [{ label: "notice", content: block.note }];
    case "diagnostic":
      return [{ label: "diagnostic", content: block.note }];
    case "unknown":
      return [{ label: "kind", content: block.observedKind }];
    default:
      return assertNever(block, "unhandled block kind");
  }
}

/**
 * Body for `transcript.includeInDraft`.
 *
 * Expanded disclosed region when the block is expanded, otherwise the selected
 * block's body. Both read the same source fields; expansion does not invent
 * missing bytes.
 */
export function pickTranscriptIncludeBody(
  block: TranscriptBlock,
  expanded: boolean,
): TranscriptIncludePick {
  if (block.sensitivity === "secret") {
    return { ok: false, reason: "This entry is secret and cannot be included." };
  }

  const bodies = includeBodiesOf(block);
  if (bodies.length === 0) {
    return { ok: false, reason: "This entry has no includeable body." };
  }

  const parts: string[] = [];
  for (const body of bodies) {
    const refused = refuseIncomplete(body.content, expanded);
    if (refused !== null) {
      return { ok: false, reason: refused };
    }
    if (body.content.text !== "") {
      parts.push(body.content.text);
    }
  }

  if (parts.length === 0) {
    return { ok: false, reason: "This entry has no includeable body." };
  }

  return { ok: true, blockKey: blockKey(block.anchor), text: parts.join("\n") };
}

function refuseIncomplete(content: BoundedText, expanded: boolean): string | null {
  switch (content.disclosure.kind) {
    case "complete":
      return null;
    case "truncated":
      return expanded
        ? "This entry is truncated; include needs the complete source, not the disclosed prefix."
        : "This entry is truncated; include needs the complete source, not the displayed prefix.";
    case "redacted":
      return "This entry is withheld and cannot be included.";
    case "omitted":
      return "This entry was not collected and cannot be included.";
    default: {
      const exhaustive: never = content.disclosure;
      return exhaustive;
    }
  }
}
