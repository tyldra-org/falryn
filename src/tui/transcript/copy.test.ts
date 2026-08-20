/**
 * Copy a transcript pick to the clipboard (#623).
 */

import { describe, expect, test } from "bun:test";
import { digestBytes } from "../../application/index.ts";
import { blockKey } from "../../presentation/index.ts";
import { everyBlockKind } from "../../presentation/transcript/fixtures.ts";
import type { CopyTextPort } from "../clipboard.ts";
import { copyTranscriptBody, copyTranscriptIdentity } from "./copy.ts";

const encoder = new TextEncoder();

const CORPUS = everyBlockKind();

function ofKind(kind: (typeof CORPUS)[number]["kind"]) {
  const block = CORPUS.find((candidate) => candidate.kind === kind);
  if (block === undefined) {
    throw new Error(`no fixture for ${kind}`);
  }
  return block;
}

const clipboardPort: CopyTextPort = {
  tryClipboard: () => true,
  plainPrint: () => false,
};

const plainPort: CopyTextPort = {
  tryClipboard: () => false,
  plainPrint: () => true,
};

describe("copyTranscriptBody", () => {
  test("copies a selected block body through the clipboard port", () => {
    const block = ofKind("user-input");
    const result = copyTranscriptBody({
      selected: blockKey(block.anchor),
      expanded: new Set(),
      blocks: [block],
      port: clipboardPort,
      digestRange: (text) => digestBytes(encoder.encode(text)),
    });
    expect(result).toEqual({ ok: true, delivery: "clipboard" });
  });

  test("copies a native range with the same pick order as include", () => {
    const block = ofKind("user-input");
    const key = blockKey(block.anchor);
    const result = copyTranscriptBody({
      selected: key,
      expanded: new Set([key]),
      blocks: [block],
      nativeRange: { start: 7, end: 11 },
      port: plainPort,
      digestRange: () => "unused",
    });
    expect(result).toEqual({ ok: true, delivery: "plain-print" });
  });

  test("refuses a secret entry without calling the port", () => {
    const block = ofKind("tool-request");
    let called = false;
    const port: CopyTextPort = {
      tryClipboard: () => {
        called = true;
        return true;
      },
      plainPrint: () => false,
    };
    const result = copyTranscriptBody({
      selected: blockKey(block.anchor),
      expanded: new Set([blockKey(block.anchor)]),
      blocks: [block],
      port,
      digestRange: () => "unused",
    });
    expect(result).toEqual({
      ok: false,
      reason: "This entry is secret and cannot be included.",
    });
    expect(called).toBe(false);
  });

  test("refuses when nothing is selected", () => {
    const result = copyTranscriptBody({
      selected: null,
      expanded: new Set(),
      blocks: CORPUS,
      port: clipboardPort,
      digestRange: () => "unused",
    });
    expect(result).toEqual({ ok: false, reason: "There is no entry to copy." });
  });
});

describe("copyTranscriptIdentity", () => {
  test("copies a file path, not the detail body", () => {
    const block = ofKind("file-change");
    const result = copyTranscriptIdentity({
      selected: blockKey(block.anchor),
      blocks: [block],
      port: clipboardPort,
    });
    expect(result).toEqual({ ok: true, delivery: "clipboard" });
  });

  test("copies a tool capability line", () => {
    const block = ofKind("tool-result");
    if (block.kind !== "tool-result") {
      throw new Error("expected tool-result");
    }
    let copied = "";
    const port: CopyTextPort = {
      tryClipboard: (text) => {
        copied = text;
        return true;
      },
      plainPrint: () => false,
    };
    const result = copyTranscriptIdentity({
      selected: blockKey(block.anchor),
      blocks: [block],
      port,
    });
    expect(result.ok).toBe(true);
    expect(copied).toBe(block.capability);
    expect(copied).not.toContain("stdout");
  });

  test("copies an artifact id", () => {
    const block = ofKind("artifact");
    if (block.kind !== "artifact") {
      throw new Error("expected artifact");
    }
    let copied = "";
    const port: CopyTextPort = {
      tryClipboard: (text) => {
        copied = text;
        return true;
      },
      plainPrint: () => false,
    };
    copyTranscriptIdentity({
      selected: blockKey(block.anchor),
      blocks: [block],
      port,
    });
    expect(copied).toBe(block.artifactId);
  });

  test("refuses message bodies without an identity", () => {
    const block = ofKind("user-input");
    const result = copyTranscriptIdentity({
      selected: blockKey(block.anchor),
      blocks: [block],
      port: clipboardPort,
    });
    expect(result).toEqual({
      ok: false,
      reason: "This entry has no copyable identity.",
    });
  });
});
