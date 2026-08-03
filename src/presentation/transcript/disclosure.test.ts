/**
 * Telling "there is more" from "you may not see this" from "nobody looked".
 *
 * Every test here is about a distinction that a single boolean would erase.
 * They are worth the space because the erasure is silent: a view built on
 * `truncated: boolean` renders correctly, ships, and misreports a redaction as
 * a large file for as long as nobody checks.
 */

import { describe, expect, test } from "bun:test";
import {
  bound,
  complete,
  describeDisclosure,
  isComplete,
  measureExtent,
  omitted,
  RETENTION_LIMITS,
  redacted,
  routeOf,
} from "./disclosure.ts";

describe("measuring content", () => {
  test("counts bytes rather than string length", () => {
    // "how big is this" is answered in the unit the file had.
    expect(measureExtent("日本").bytes).toBe(6);
    expect(measureExtent("日本").lines).toBe(1);
  });

  test("reports no lines for no content", () => {
    // A block claiming "1 line" for nothing is the same invention as "0
    // results" for a paragraph.
    expect(measureExtent("").lines).toBe(0);
  });

  test("leaves a result count absent unless it was given one", () => {
    expect(measureExtent("two matches").results).toBe(null);
    expect(measureExtent("two matches", 2).results).toBe(2);
  });
});

describe("content that fits", () => {
  test("is complete and unchanged", () => {
    const bounded = bound("a short line");
    expect(bounded.text).toBe("a short line");
    expect(isComplete(bounded.disclosure)).toBe(true);
  });

  test("is still sanitized", () => {
    // The one rule that applies whatever the size: a value someone else wrote
    // does not get to move the cursor.
    const bounded = complete("\u001b[2Jcleared");
    expect(bounded.text).not.toContain("\u001b");
    expect(isComplete(bounded.disclosure)).toBe(true);
  });

  test("keeps its lines while losing everything else that moves a cursor", () => {
    // The one place the domain's sanitizer is not applied whole. A transcript
    // rendering model prose with an escaped newline between every line would be
    // unreadable in exactly the case it exists for. A newline is the only
    // control character that survives; every other one is still escaped by the
    // domain's rule, applied a line at a time.
    const bounded = complete("first\nsecond\tthird\u001b[31m");
    expect(bounded.text.split("\n")).toHaveLength(2);
    expect(bounded.text).not.toContain("\u001b");
    expect(bounded.text).not.toContain("\t");
  });

  test("normalizes line endings rather than escaping the carriage return", () => {
    // Otherwise every line of a file written on Windows ends in a visible
    // escape, which reads as corruption and is only a line ending.
    expect(complete("first\r\nsecond\rthird").text).toBe("first\nsecond\nthird");
  });
});

describe("content that does not fit", () => {
  test("is truncated with exact counts and a route", () => {
    const bounded = bound("line\n".repeat(200), { bytes: 4_096, lines: 10 });
    expect(bounded.disclosure.kind).toBe("truncated");
    if (bounded.disclosure.kind === "truncated") {
      expect(bounded.disclosure.shown.lines).toBe(10);
      expect(bounded.disclosure.total.lines).toBe(201);
      expect(bounded.disclosure.route).toBe("transcript.expand");
      // The counts describe the same content the text is a prefix of.
      expect(bounded.disclosure.shown.bytes).toBeLessThan(bounded.disclosure.total.bytes);
    }
  });

  test("measures the sanitized text rather than the raw text", () => {
    // Measuring before sanitizing reports a count for content that was never
    // retained, and de-fanging an escape makes it longer rather than shorter —
    // so the two numbers differ by more than rounding.
    const raw = `${"\u001b[31m".repeat(50)}red`;
    const bounded = bound(raw, { bytes: 32, lines: 100 });
    expect(bounded.text).not.toContain("\u001b");
    if (bounded.disclosure.kind === "truncated") {
      expect(bounded.disclosure.total.bytes).toBeGreaterThan(
        new TextEncoder().encode(raw).length - 1,
      );
    }
  });

  test("never cuts a character in half", () => {
    // Slicing by index would leave an unpaired surrogate: content that is no
    // longer text, produced by the function whose job was to keep it readable.
    const bounded = bound("\u{1d400}".repeat(50), { bytes: 9, lines: 100 });
    expect([...bounded.text].every((character) => character.codePointAt(0) !== 0xfffd)).toBe(true);
    expect(new TextEncoder().encode(bounded.text).length).toBeLessThanOrEqual(9);
    // Astral characters are four bytes, so a nine-byte budget holds two.
    expect([...bounded.text].length).toBe(2);
  });

  test("carries a result count on the total and not on the shown half", () => {
    // How many of a search's results survived a byte clip is not recoverable
    // from the clipped text. An invented number beside two measured ones is
    // worse than an absent one.
    const bounded = bound("match\n".repeat(900), { bytes: 64, lines: 8 }, 900);
    if (bounded.disclosure.kind === "truncated") {
      expect(bounded.disclosure.total.results).toBe(900);
      expect(bounded.disclosure.shown.results).toBe(null);
    }
  });
});

describe("the three ways content is missing", () => {
  const cases = [
    bound("x\n".repeat(RETENTION_LIMITS.lines + 10)),
    redacted("the value is a credential"),
    omitted("no diagnostics collector ran"),
  ];

  test("are three different kinds", () => {
    expect(cases.map((bounded) => bounded.disclosure.kind)).toEqual([
      "truncated",
      "redacted",
      "omitted",
    ]);
  });

  test("are described in words that differ", () => {
    // Words rather than a symbol or a colour: this is the sentence that
    // survives a monochrome terminal, and it is the one a user most needs.
    const described = cases.map((bounded) => describeDisclosure(bounded.disclosure));
    expect(new Set(described).size).toBe(3);
    for (const sentence of described) {
      expect(sentence.length).toBeGreaterThan(0);
    }
  });

  test("promise a route only when there is somewhere to go", () => {
    // Truncation always has one. The other two may have none, and offering a
    // route a user cannot follow is an interface promising what no command
    // delivers.
    expect(routeOf(cases[0]?.disclosure ?? { kind: "complete" })).toBe("transcript.expand");
    expect(routeOf(cases[1]?.disclosure ?? { kind: "complete" })).toBe(null);
    expect(routeOf(cases[2]?.disclosure ?? { kind: "complete" })).toBe(null);
  });

  test("hold no content when they are withheld or uncollected", () => {
    // A redaction that still carried the text would be a redaction in name.
    expect(cases[1]?.text).toBe("");
    expect(cases[2]?.text).toBe("");
  });

  test("say why, for the two that are decisions rather than sizes", () => {
    const withheld = cases[1]?.disclosure;
    const uncollected = cases[2]?.disclosure;
    expect(withheld?.kind === "redacted" && withheld.reason.length > 0).toBe(true);
    expect(uncollected?.kind === "omitted" && uncollected.reason.length > 0).toBe(true);
  });
});

describe("complete content", () => {
  test("offers no route, because there is nothing behind it", () => {
    expect(routeOf({ kind: "complete" })).toBe(null);
    expect(describeDisclosure({ kind: "complete" })).toBe("Complete.");
  });
});
