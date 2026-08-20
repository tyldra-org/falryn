/**
 * Clipboard copy with plain-print fallback (#623).
 */

import { describe, expect, test } from "bun:test";
import { type CopyTextPort, copyText } from "./clipboard.ts";

describe("copyText", () => {
  test("returns clipboard delivery when OSC 52 succeeds", () => {
    const port: CopyTextPort = {
      tryClipboard: (text) => text === "hello",
      plainPrint: () => false,
    };
    expect(copyText("hello", port)).toEqual({ ok: true, delivery: "clipboard" });
  });

  test("falls back to plain print when clipboard fails", () => {
    const port: CopyTextPort = {
      tryClipboard: () => false,
      plainPrint: () => true,
    };
    expect(copyText("hello", port)).toEqual({ ok: true, delivery: "plain-print" });
  });

  test("refuses empty text", () => {
    const port: CopyTextPort = {
      tryClipboard: () => true,
      plainPrint: () => true,
    };
    expect(copyText("", port)).toEqual({ ok: false, reason: "There is nothing to copy." });
  });

  test("reports failure when both paths fail", () => {
    const port: CopyTextPort = {
      tryClipboard: () => false,
      plainPrint: () => false,
    };
    expect(copyText("hello", port)).toEqual({
      ok: false,
      reason: "Clipboard is unavailable and plain output failed.",
    });
  });
});
