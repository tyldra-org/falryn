/**
 * Rows, resolved to lines.
 *
 * Pure, so every property here is asserted without a terminal. The three that
 * matter are the ones a scrollback commit cannot take back: a status keeps its
 * word, a hostile byte cannot forge a line, and a colour the terminal does not
 * have stays absent rather than becoming a grey.
 */

import { describe, expect, test } from "bun:test";
import { resolveTheme, STATUS_PRESENTATION, type Theme } from "../theme/index.ts";
import { drawableLine, drawableLines } from "./lines.ts";
import type { TranscriptRow } from "./rows.ts";

const REQUEST = {
  variant: "dark",
  colorLevel: "truecolor",
  symbols: "unicode",
  reducedMotion: true,
  generation: 1,
} as const;

const THEME: Theme = resolveTheme(REQUEST);

function text(overrides: Partial<Extract<TranscriptRow, { kind: "text" }>> = {}): TranscriptRow {
  return {
    kind: "text",
    key: "row",
    text: "the body",
    color: "foreground",
    typography: "body",
    untrusted: false,
    indent: 0,
    ...overrides,
  };
}

function status(
  overrides: Partial<Extract<TranscriptRow, { kind: "status" }>> = {},
): TranscriptRow {
  return {
    kind: "status",
    key: "row",
    status: "error",
    label: "it failed",
    indent: 0,
    ...overrides,
  };
}

describe("a status row", () => {
  test("carries the symbol and the word, never the colour alone", () => {
    // The same guarantee `StatusMark` makes on the live surface, from the same
    // table. A committed row is permanent, so a status reduced to a coloured
    // glyph would be unreadable on a monochrome terminal forever.
    const line = drawableLine(status(), THEME, 40);
    const presentation = STATUS_PRESENTATION.error;
    expect(line.text).toBe(`${THEME.symbol(presentation.symbol)} it failed`);
    expect(line.color).toBe(THEME.color(presentation.token));
  });

  test("keeps its word when the terminal has no colour at all", () => {
    const monochrome = resolveTheme({ ...REQUEST, colorLevel: "none" });
    const line = drawableLine(status(), monochrome, 40);
    expect(line.color).toBeNull();
    expect(line.text).toContain("it failed");
  });
});

describe("every line", () => {
  test("is sanitized whether or not the row was flagged untrusted", () => {
    // The flag says where the text came from. It does not say where the text is
    // going, and scrollback is the one destination nothing can repaint. Written
    // from a code point rather than as an escape literal so this file does not
    // carry a raw control byte of its own.
    const control = String.fromCodePoint(0x1b);
    const forged = drawableLine(
      text({ text: `safe${control}[31mred`, untrusted: false }),
      THEME,
      40,
    );
    expect(forged.text).not.toContain(control);
    expect(forged.text).toContain("\\x1b");
    expect(forged.text).toContain("safe");
  });

  test("spends the indent from the same budget as the text", () => {
    // Indented and then fitted, rather than fitted and then pushed past the
    // edge. A line wider than the terminal wraps where the terminal decides,
    // which is the one place the surface has no say.
    const line = drawableLine(text({ text: "abcdefghij", indent: 4 }), THEME, 8);
    expect(line.text.startsWith("    ")).toBe(true);
    expect([...line.text].length).toBeLessThanOrEqual(8);
  });

  test("carries the attributes of its typography role", () => {
    const heading = drawableLine(text({ typography: "heading" }), THEME, 40);
    const body = drawableLine(text({ typography: "body" }), THEME, 40);
    expect(heading.attributes).not.toBe(body.attributes);
  });
});

describe("a set of rows", () => {
  test("resolves one line per row, in order", () => {
    const lines = drawableLines([status({ label: "first" }), text({ text: "second" })], THEME, 40);
    expect(lines.length).toBe(2);
    expect(lines[0]?.text).toContain("first");
    expect(lines[1]?.text).toContain("second");
  });
});
