/**
 * Clipboard copy with plain-print fallback (#623).
 *
 * OSC 52 when the renderer supports it; otherwise a labelled stderr write so
 * copy still works without a clipboard consumer. Failure never clears a native
 * selection — callers report and leave the pick intact.
 */

export type CopyDelivery = "clipboard" | "plain-print";

export type CopyTextResult =
  | { readonly ok: true; readonly delivery: CopyDelivery }
  | { readonly ok: false; readonly reason: string };

export type CopyTextPort = {
  readonly tryClipboard: (text: string) => boolean;
  readonly plainPrint: (text: string) => boolean;
};

export function copyText(text: string, port: CopyTextPort): CopyTextResult {
  if (text.length === 0) {
    return { ok: false, reason: "There is nothing to copy." };
  }
  if (port.tryClipboard(text)) {
    return { ok: true, delivery: "clipboard" };
  }
  if (port.plainPrint(text)) {
    return { ok: true, delivery: "plain-print" };
  }
  return { ok: false, reason: "Clipboard is unavailable and plain output failed." };
}
