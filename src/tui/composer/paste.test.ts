/**
 * What arrives when someone pastes.
 *
 * The rule these tests exist for is the first one: **a paste never runs a
 * command.** Classification returns a verdict and text, and nothing in the union
 * it returns can be mistaken for a keystroke — which is the structural version
 * of that promise, and the reason a pasted shell transcript cannot submit itself
 * halfway through.
 */

import { describe, expect, test } from "bun:test";
import {
  classifyPaste,
  describePaste,
  INLINE_PASTE_LIMIT,
  looksSecret,
  MAX_PASTE_BYTES,
  noticeOfPaste,
  PASTE_VERDICTS,
  PREVIEW_LINES,
  previewWidth,
} from "./paste.ts";

describe("a small paste", () => {
  test("goes in as text", () => {
    const classified = classifyPaste("a path or a paragraph");
    expect(classified.verdict).toBe("inline");
    expect(classified.verdict === "inline" && classified.text).toBe("a path or a paragraph");
  });

  test("is inline right up to the limit", () => {
    // The boundary, from both sides: an off-by-one here turns an ordinary paste
    // into a confirmation prompt or the reverse.
    expect(classifyPaste("x".repeat(INLINE_PASTE_LIMIT)).verdict).toBe("inline");
    expect(classifyPaste("x".repeat(INLINE_PASTE_LIMIT + 1)).verdict).toBe("preview");
  });

  test("carries a newline without that meaning anything", () => {
    // The whole point of bracketed paste. A newline in pasted text is content,
    // not a submission, and the classification says so by returning text.
    const classified = classifyPaste("first\nsecond");
    expect(classified.verdict).toBe("inline");
    expect(classified.verdict === "inline" && classified.text.includes("\n")).toBe(true);
  });

  test("accepts an empty paste rather than treating it as a failure", () => {
    expect(classifyPaste("").verdict).toBe("inline");
  });
});

describe("a large paste", () => {
  test("becomes a bounded preview rather than content", () => {
    const text = Array.from({ length: 400 }, (_, index) => `line ${index}`).join("\n");
    const classified = classifyPaste(text);
    expect(classified.verdict).toBe("preview");
    if (classified.verdict === "preview") {
      expect(classified.preview.length).toBe(PREVIEW_LINES);
      expect(classified.hiddenLines).toBe(400 - PREVIEW_LINES);
      expect(classified.lines).toBe(400);
      // The whole text is carried so "include" does not have to re-read a
      // clipboard that may have changed since.
      expect(classified.text).toBe(text);
    }
  });

  test("sanitizes the preview it shows", () => {
    // A pasted log can contain an escape sequence, and the preview is the first
    // place it would reach a terminal.
    const text = `\u001b[2Jcleared\n${"x".repeat(INLINE_PASTE_LIMIT)}`;
    const classified = classifyPaste(text);
    expect(classified.verdict).toBe("preview");
    if (classified.verdict === "preview") {
      expect(classified.preview[0]).not.toContain("\u001b");
      expect(classified.preview[0]).toContain("\\x1b");
    }
  });

  test("reports a preview's widest line in cells", () => {
    expect(previewWidth(["ab", "abcd"])).toBe(4);
    // Measured, not counted: a wide glyph is two cells.
    expect(previewWidth(["漢字"])).toBe(4);
  });
});

describe("a paste that is not text", () => {
  test("is refused when it contains a null byte", () => {
    const classified = classifyPaste("binary\u0000content");
    expect(classified.verdict).toBe("refused");
    expect(classified.verdict === "refused" && classified.refusal).toBe("binary");
  });

  test("is refused when it contains an unpaired surrogate", () => {
    const classified = classifyPaste(`lone \ud800 half`);
    expect(classified.verdict).toBe("refused");
    expect(classified.verdict === "refused" && classified.refusal).toBe("invalid-encoding");
  });

  test("accepts a matched surrogate pair, which is an ordinary character", () => {
    // The check must not refuse every astral character along with the broken
    // ones — an emoji in a pasted commit message is not a failure.
    expect(classifyPaste("an astral char: \u{1d400}").verdict).toBe("inline");
  });

  test("is refused when it is larger than anything worth holding", () => {
    const classified = classifyPaste("x".repeat(MAX_PASTE_BYTES + 1));
    expect(classified.verdict).toBe("refused");
    expect(classified.verdict === "refused" && classified.refusal).toBe("too-large");
  });

  test("says which kind of nothing it was", () => {
    for (const text of ["a\u0000b", "\ud800", "x".repeat(MAX_PASTE_BYTES + 1)]) {
      const classified = classifyPaste(text);
      expect(classified.verdict === "refused" && classified.detail.length > 0).toBe(true);
    }
  });
});

describe("what the user is told", () => {
  test("describes every verdict in words", () => {
    // Words rather than a symbol or a colour, so the outcome survives a
    // monochrome terminal — which is where someone is most likely pasting a log.
    const samples = [
      classifyPaste("short"),
      classifyPaste("x".repeat(INLINE_PASTE_LIMIT + 1)),
      classifyPaste("a\u0000b"),
    ];
    expect(samples.map((sample) => noticeOfPaste(sample).verdict).sort()).toEqual(
      [...PASTE_VERDICTS].sort(),
    );
    for (const sample of samples) {
      expect(describePaste(noticeOfPaste(sample)).length).toBeGreaterThan(0);
    }
    expect(
      describePaste(noticeOfPaste(classifyPaste("x".repeat(INLINE_PASTE_LIMIT + 1)))),
    ).toContain("not inserted");
    expect(
      describePaste(noticeOfPaste(classifyPaste("x".repeat(INLINE_PASTE_LIMIT + 1)))),
    ).not.toContain("showing");
  });
});

describe("content that looks like a credential", () => {
  test("is marked rather than refused or redacted", () => {
    // A weak signal used for a weak response. Refusing would make pasting a
    // config file impossible; redacting here would be a second redaction rule.
    expect(looksSecret("export API_KEY=abc123")).toBe(true);
    expect(looksSecret("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
    expect(looksSecret("an ordinary sentence")).toBe(false);
  });

  test("does not change the verdict", () => {
    expect(classifyPaste("password=hunter2").verdict).toBe("inline");
  });

  test("marks a preview rather than refusing it", () => {
    const classified = classifyPaste(`export API_KEY=abc123\n${"x".repeat(INLINE_PASTE_LIMIT)}`);
    expect(classified.verdict).toBe("preview");
    const notice = noticeOfPaste(classified);
    expect(notice.verdict === "preview" && notice.secret).toBe(true);
    expect(describePaste(notice)).toContain("Looks like a credential");
    expect("text" in notice).toBe(false);
    expect("preview" in notice).toBe(false);
  });
});
