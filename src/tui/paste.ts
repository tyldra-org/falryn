/**
 * What arrives when someone pastes.
 *
 * Bracketed paste is the terminal telling us a block of text came from the
 * clipboard rather than from the keyboard, and the distinction matters for one
 * reason above all others: **pasted text must never run a command.** Without
 * bracketing, a paste containing a newline is indistinguishable from someone
 * pressing Enter, which is how a pasted shell transcript submits itself halfway
 * through. Classification happens here so no consumer has to remember that.
 *
 * The other reason is size. A clipboard can hold a whole file, and a terminal
 * editor handed one becomes unresponsive while it measures every line. Anything
 * past the threshold becomes a preview the user decides about, rather than
 * content the interface has already committed to.
 *
 * This module imports no OpenTUI value and holds no state. It classifies bytes
 * and returns a verdict.
 */

import { displayWidth, sanitizeTerminalText } from "../domain/index.ts";

/**
 * Characters that enter an editor directly.
 *
 * A few hundred is a paragraph, a path, or a stack frame — the ordinary things
 * people paste into a prompt. Past it the cost of measuring and wrapping starts
 * to show, and the user is better served by being asked.
 */
export const INLINE_PASTE_LIMIT = 2_048;

/** Characters read at all. Beyond this the content is reported, never held. */
export const MAX_PASTE_BYTES = 4 * 1024 * 1024;

/** Lines shown in a preview before it says how many more there were. */
export const PREVIEW_LINES = 8;

export const PASTE_VERDICTS = ["inline", "preview", "refused"] as const;

export type PasteVerdict = (typeof PASTE_VERDICTS)[number];

export const PASTE_REFUSALS = ["too-large", "binary", "invalid-encoding"] as const;

export type PasteRefusal = (typeof PASTE_REFUSALS)[number];

export type PasteClassification =
  /** Small and clean. Goes into the editor as text. */
  | { readonly verdict: "inline"; readonly text: string; readonly characters: number }
  /**
   * Large but readable. The user inspects, includes, excludes, or cancels.
   *
   * The preview is sanitized and bounded; the full text is carried alongside so
   * "include" does not have to re-read a clipboard that may have changed.
   */
  | {
      readonly verdict: "preview";
      readonly text: string;
      readonly characters: number;
      readonly lines: number;
      readonly preview: readonly string[];
      readonly hiddenLines: number;
    }
  /** Nothing usable. Carries which kind of nothing, so the notice can say. */
  | { readonly verdict: "refused"; readonly refusal: PasteRefusal; readonly detail: string };

/**
 * What the composer keeps about a paste: a notice, never the clipboard body.
 *
 * Preview classifications carry the full text so an include path can attach it
 * later. That payload must not sit on composer state — including a large paste
 * is #278, and holding megabytes against a decision nobody can make is memory
 * spent on a capability that does not exist.
 */
export type PasteNotice =
  | { readonly verdict: "inline"; readonly characters: number; readonly secret: boolean }
  | {
      readonly verdict: "preview";
      readonly characters: number;
      readonly lines: number;
      readonly secret: boolean;
    }
  | {
      readonly verdict: "refused";
      readonly refusal: PasteRefusal;
      readonly detail: string;
    };

/** Strip a classification down to what two chrome rows can honestly say. */
export function noticeOfPaste(classification: PasteClassification): PasteNotice {
  switch (classification.verdict) {
    case "inline":
      return {
        verdict: "inline",
        characters: classification.characters,
        secret: looksSecret(classification.text),
      };
    case "preview":
      return {
        verdict: "preview",
        characters: classification.characters,
        lines: classification.lines,
        secret: looksSecret(classification.text),
      };
    case "refused":
      return {
        verdict: "refused",
        refusal: classification.refusal,
        detail: classification.detail,
      };
    default: {
      const exhaustive: never = classification;
      return exhaustive;
    }
  }
}

/**
 * Whether these bytes look like something other than text.
 *
 * A NUL is the signal every tool uses for this, and for the same reason: it
 * cannot appear in valid UTF-8 text that a person typed, and it is what a
 * binary file has in its first few hundred bytes. Checking a prefix rather than
 * the whole buffer keeps the cost bounded for a paste that is about to be
 * refused anyway.
 */
function looksBinary(text: string): boolean {
  // `\0` written as an escape, never as a literal byte — the rule
  // `src/source-text.test.ts` exists to hold, and the exact mistake that made
  // `text-cache.ts` a binary file.
  return text.slice(0, 4096).includes("\0");
}

/**
 * Text that reads like a credential.
 *
 * Deliberately a weak signal used for a weak response: it does not refuse the
 * paste and does not redact it. Preview notices carry the mark so the chrome
 * can warn before the text is committed somewhere durable. A strong classifier
 * here would be a second redaction rule, and `src/application/redaction.ts`
 * owns that one.
 */
const SECRET_SHAPED =
  /\b(api[_-]?key|secret|token|password|passwd|bearer|private[_-]?key|BEGIN [A-Z ]*PRIVATE KEY)\b/i;

export function looksSecret(text: string): boolean {
  return SECRET_SHAPED.test(text);
}

/**
 * What to do with a pasted block.
 *
 * The order of the checks is the contract: refusals first, because a binary
 * paste that happened to be short must not be inlined, and an over-long paste
 * must be reported without its content being measured line by line.
 */
export function classifyPaste(text: string): PasteClassification {
  if (text.length > MAX_PASTE_BYTES) {
    return {
      verdict: "refused",
      refusal: "too-large",
      detail: `${text.length} characters; the limit is ${MAX_PASTE_BYTES}`,
    };
  }
  if (looksBinary(text)) {
    return {
      verdict: "refused",
      refusal: "binary",
      detail: "the content contains a null byte, so it is not text",
    };
  }
  // An *unpaired* surrogate: a high one with no low after it, or a low one with
  // no high before it. A matched pair is an ordinary astral character and must
  // pass. Sanitizing would hide the difference; refusing says what happened,
  // and what happened is that the clipboard handed over something that is not
  // text.
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text)) {
    return {
      verdict: "refused",
      refusal: "invalid-encoding",
      detail: "the content contains an unpaired surrogate, so it is not text",
    };
  }

  if (text.length <= INLINE_PASTE_LIMIT) {
    return { verdict: "inline", text, characters: text.length };
  }

  const lines = text.split("\n");
  const preview = lines.slice(0, PREVIEW_LINES).map((line) => sanitizeTerminalText(line));
  return {
    verdict: "preview",
    text,
    characters: text.length,
    lines: lines.length,
    preview,
    hiddenLines: Math.max(0, lines.length - PREVIEW_LINES),
  };
}

/**
 * One line describing a classification, for the status line or a notice.
 *
 * Words rather than a symbol or a colour, so the outcome of a paste survives a
 * monochrome terminal — which is where someone is most likely to be pasting a
 * log they cannot otherwise read.
 */
export function describePaste(notice: PasteNotice): string {
  switch (notice.verdict) {
    case "inline":
      return `Pasted ${notice.characters} characters.`;
    case "preview": {
      const held = `Pasted ${notice.characters} characters over ${notice.lines} lines; not inserted.`;
      return notice.secret ? `${held} Looks like a credential.` : held;
    }
    case "refused":
      return `Paste refused: ${notice.detail}.`;
    default: {
      const exhaustive: never = notice;
      return exhaustive;
    }
  }
}

/** The widest line a preview will draw, for a caller sizing a region. */
export function previewWidth(preview: readonly string[]): number {
  let widest = 0;
  for (const line of preview) {
    widest = Math.max(widest, displayWidth(line));
  }
  return widest;
}
