/**
 * What a block looks like, without a terminal.
 *
 * The corpus is `everyBlockKind()` — the same fixtures the projection area uses
 * — so "the surface is total over the block model" means every kind was actually
 * rendered rather than that a switch looked exhaustive. The three disclosure
 * classes and all three sensitivity classes are in that corpus for exactly this
 * reason.
 */

import { describe, expect, test } from "bun:test";
import { timestampFromEpochMilliseconds } from "../../domain/index.ts";
import type { ExpansionRoute, TranscriptBlock } from "../../presentation/index.ts";
import { blockKey, complete, omitted, redacted } from "../../presentation/index.ts";
import { everyBlockKind } from "../../presentation/transcript/fixtures.ts";
import { SYMBOL_SETS } from "../theme/symbols.ts";
import {
  collapsedRows,
  disclosureNotice,
  relativeTime,
  rowsForBlock,
  statusOfBlock,
  type TranscriptRow,
} from "./rows.ts";

const SYMBOLS = SYMBOL_SETS.unicode;

/** A wrap that splits on a fixed width without measuring, so rows are predictable. */
function wrap(text: string, width: number): readonly string[] {
  const lines: string[] = [];
  for (let start = 0; start < text.length; start += width) {
    lines.push(text.slice(start, start + width));
  }
  return lines.length === 0 ? [""] : lines;
}

function describeRoute(route: ExpansionRoute): string {
  return `[route ${route}]`;
}

/**
 * One fixture block by kind, or a failure naming what is missing.
 *
 * A helper rather than a cast at each call site: a cast would turn a corpus that
 * stopped covering a kind into `undefined` reaching an assertion, failing
 * somewhere unrelated to the fixture that went away.
 */
function ofKind(kind: TranscriptBlock["kind"]): TranscriptBlock {
  const block = everyBlockKind().find((candidate) => candidate.kind === kind);
  if (block === undefined) {
    throw new Error(`the block corpus has no ${kind} block`);
  }
  return block;
}

/** The fixture carrying a sensitivity class, by the same reasoning. */
function ofSensitivity(sensitivity: TranscriptBlock["sensitivity"]): TranscriptBlock {
  const block = everyBlockKind().find((candidate) => candidate.sensitivity === sensitivity);
  if (block === undefined) {
    throw new Error(`the block corpus has no ${sensitivity} block`);
  }
  return block;
}

function build(
  block: TranscriptBlock,
  overrides: { expanded?: boolean; selected?: boolean; columns?: number } = {},
): readonly TranscriptRow[] {
  return rowsForBlock({
    block,
    expanded: overrides.expanded ?? false,
    selected: overrides.selected ?? false,
    columns: overrides.columns ?? 60,
    symbols: SYMBOLS,
    wrap,
    describeRoute,
    relativeTo: null,
  });
}

function textOf(rows: readonly TranscriptRow[]): string {
  return rows.map((row) => (row.kind === "status" ? row.label : row.text)).join("\n");
}

/**
 * The rows carrying a block's own content.
 *
 * Matched by key rather than by "is untrusted text", because the provenance row
 * is untrusted text too — it carries identifiers that came from outside Falryn.
 * A filter that could not tell the two apart would count provenance as content
 * and pass a test about a secret block that was leaking one.
 */
function contentRowsOf(rows: readonly TranscriptRow[]): readonly TranscriptRow[] {
  return rows.filter((row) => row.key.includes(":content:"));
}

/** A model-text block carrying whatever content a case needs. */
function modelTextWith(text: TranscriptBlock["summary"]): TranscriptBlock {
  const block = ofKind("model-text");
  if (block.kind !== "model-text") {
    throw new Error("the corpus returned the wrong kind");
  }
  return { ...block, text };
}

describe("every declared kind", () => {
  test("renders collapsed, and says what it is", () => {
    // Total over the model rather than over the five kinds a producer exists
    // for. The other eleven reach a user the day #33 emits them.
    for (const block of everyBlockKind()) {
      const rows = build(block);
      expect({ kind: block.kind, rows: rows.length > 0 }).toEqual({ kind: block.kind, rows: true });
      expect({ kind: block.kind, first: rows[0]?.kind }).toEqual({
        kind: block.kind,
        first: "status",
      });
    }
  });

  test("renders expanded without losing its identity row", () => {
    for (const block of everyBlockKind()) {
      const rows = build(block, { expanded: true });
      expect({ kind: block.kind, headline: rows[0]?.key }).toEqual({
        kind: block.kind,
        headline: `${blockKey(block.anchor)}:headline`,
      });
    }
  });

  test("keeps every row's key stable and unique", () => {
    // Stable keys are what let a revised block re-render in place instead of
    // being torn down and rebuilt somewhere else.
    for (const block of everyBlockKind()) {
      const rows = build(block, { expanded: true });
      const keys = rows.map((row) => row.key);
      expect({ kind: block.kind, unique: new Set(keys).size }).toEqual({
        kind: block.kind,
        unique: keys.length,
      });
      for (const key of keys) {
        expect({ kind: block.kind, prefixed: key.startsWith(blockKey(block.anchor)) }).toEqual({
          kind: block.kind,
          prefixed: true,
        });
      }
    }
  });

  test("agrees with its own collapsed height", () => {
    // The property the virtualizer depends on: `collapsedRows` is not an
    // estimate of what `rowsForBlock` produces, it is the same answer.
    for (const block of everyBlockKind()) {
      expect({ kind: block.kind, rows: build(block).length }).toEqual({
        kind: block.kind,
        rows: collapsedRows(block),
      });
    }
  });

  test("has a collapsed height that does not depend on the width", () => {
    // What makes a hundred-thousand-block history measurable in a frame.
    for (const block of everyBlockKind()) {
      for (const columns of [24, 80, 400]) {
        expect({ kind: block.kind, columns, rows: build(block, { columns }).length }).toEqual({
          kind: block.kind,
          columns,
          rows: collapsedRows(block),
        });
      }
    }
  });
});

describe("the three ways content is missing", () => {
  test("are three different notices with three different statuses", () => {
    // The acceptance criterion. A single "truncated" flag is what this refuses
    // to be, and the proof is that the three read differently in words as well
    // as in colour.
    const truncated = disclosureNotice(
      {
        kind: "truncated",
        shown: { bytes: 10, lines: 1, results: null },
        total: { bytes: 900, lines: 90, results: 12 },
        route: "transcript.expand",
      },
      describeRoute,
    );
    const withheld = disclosureNotice(
      { kind: "redacted", reason: "it carries a credential", route: null },
      describeRoute,
    );
    const uncollected = disclosureNotice(
      { kind: "omitted", reason: "nothing collected it", route: null },
      describeRoute,
    );

    expect(truncated?.text).toStartWith("Truncated.");
    expect(withheld?.text).toStartWith("Redacted.");
    expect(uncollected?.text).toStartWith("Omitted.");
    expect(new Set([truncated?.status, withheld?.status, uncollected?.status]).size).toBe(3);
  });

  test("each carry a route or say why there is none", () => {
    // "Expand for more" must never be offered for content nobody may see or
    // nobody collected.
    expect(
      disclosureNotice(
        {
          kind: "truncated",
          shown: { bytes: 1, lines: 1, results: null },
          total: { bytes: 2, lines: 2, results: null },
          route: "transcript.expand",
        },
        describeRoute,
      )?.text,
    ).toContain("[route transcript.expand]");

    expect(
      disclosureNotice({ kind: "redacted", reason: "secret", route: null }, describeRoute)?.text,
    ).toContain("no expansion that reveals it");

    expect(
      disclosureNotice({ kind: "omitted", reason: "nobody looked", route: null }, describeRoute)
        ?.text,
    ).toContain("nothing behind it to open");
  });

  test("offer the route a redaction does have", () => {
    // Sensitive content may be revealed by an explicit expansion; secret content
    // may not. The difference is a route, and it is honoured.
    expect(
      disclosureNotice(
        { kind: "redacted", reason: "not projected by default", route: "transcript.expand" },
        describeRoute,
      )?.text,
    ).toContain("[route transcript.expand]");
  });

  test("say nothing for content that is all there", () => {
    expect(disclosureNotice({ kind: "complete" }, describeRoute)).toBe(null);
  });

  test("reach the collapsed form, so a clipped block says so before it is opened", () => {
    expect(textOf(build(ofKind("tool-result")))).toContain("Truncated.");
  });
});

describe("a secret block", () => {
  test("is withheld rather than invisible", () => {
    // A secret block still says what happened. Hiding the row entirely is how a
    // transcript becomes an incomplete account of the session.
    expect(textOf(build(ofSensitivity("secret")))).toContain("Running a provider check");
  });

  test("reveals no content when it is expanded", () => {
    const rows = build(ofSensitivity("secret"), { expanded: true });
    expect(textOf(rows)).toContain("no expansion that reveals it");
    expect(contentRowsOf(rows)).toEqual([]);
  });

  test("refuses content even when the projection hands it some", () => {
    // The second refusal. A producer that forgot to redact must not be the only
    // thing standing between a credential and a terminal.
    const block = ofSensitivity("secret");
    if (block.kind !== "tool-request") {
      throw new Error("the secret fixture is no longer a tool request");
    }
    const leaked: TranscriptBlock = { ...block, input: complete("Authorization: Bearer abcdef") };
    expect(textOf(build(leaked, { expanded: true }))).not.toContain("abcdef");
  });
});

describe("a sensitive block", () => {
  test("reveals its content only through an explicit expansion", () => {
    const collapsed = textOf(build(ofSensitivity("sensitive")));
    expect(collapsed).toContain("Reasoning withheld");
    expect(collapsed).toContain("Redacted.");
  });
});

describe("the collapsed form", () => {
  test("names the block, its summary, and how long ago it happened", () => {
    const first = ofKind("user-input");
    const later = timestampFromEpochMilliseconds(Date.UTC(2026, 7, 1, 9, 32, 0));
    const headline = textOf(
      rowsForBlock({
        block: first,
        expanded: false,
        selected: false,
        columns: 80,
        symbols: SYMBOLS,
        wrap,
        describeRoute,
        relativeTo: later,
      }),
    );
    expect(headline).toContain("You said");
    expect(headline).toContain("Rename the port");
    expect(headline).toContain("2m ago");
    expect(relativeTime(first.occurredAt, later)).toBe("2m ago");
  });

  test("marks a block that can be opened and leaves one that cannot unmarked", () => {
    expect(textOf(build(ofKind("model-text")))).toContain(SYMBOLS.collapsed);
    expect(textOf(build(ofKind("model-text"), { expanded: true }))).toContain(SYMBOLS.expanded);
    expect(textOf(build(ofKind("turn-outcome")))).not.toContain(SYMBOLS.collapsed);
  });

  test("marks the selected block in a word, not only a glyph", () => {
    // The symbol set draws `focus` and `collapsed` with the same character, so a
    // glyph alone cannot say which of the two it means.
    expect(textOf(build(ofKind("user-input"), { selected: true }))).toContain("selected");
    expect(textOf(build(ofKind("user-input"), { selected: false }))).not.toContain("selected");
  });
});

describe("the expanded form", () => {
  test("shows the block's own content, labelled", () => {
    const rows = build(ofKind("model-text"), { expanded: true });
    expect(textOf(rows)).toContain("response");
    expect(textOf(rows)).toContain("There are four callers");
  });

  test("draws content as untrusted, so a value cannot forge a line", () => {
    const rows = contentRowsOf(build(modelTextWith(complete("a\u001b[2Jb")), { expanded: true }));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect({ key: row.key, untrusted: row.kind === "text" && row.untrusted }).toEqual({
        key: row.key,
        untrusted: true,
      });
    }
  });

  test("carries provenance the projection already holds", () => {
    const rows = build(ofKind("user-input"), { expanded: true });
    expect(textOf(rows)).toContain("source user");
    expect(textOf(rows)).toContain("sensitivity ordinary");
    expect(textOf(rows)).toContain("generation");
  });

  test("re-wraps with the width, which is what a resize changes", () => {
    const long = modelTextWith(complete("x".repeat(200)));
    expect(build(long, { expanded: true, columns: 30 }).length).toBeGreaterThan(
      build(long, { expanded: true, columns: 100 }).length,
    );
  });

  test("keeps a producer's blank line rather than closing the gap", () => {
    const spaced = modelTextWith(complete("first\n\nsecond"));
    expect(contentRowsOf(build(spaced, { expanded: true })).length).toBe(3);
  });

  test("draws a notice instead of pretending an uncollected value is empty", () => {
    const uncollected = modelTextWith(omitted("nothing collected it"));
    expect(textOf(build(uncollected, { expanded: true }))).toContain("Omitted.");
  });

  test("draws a redaction notice for content that is withheld", () => {
    const withheld = modelTextWith(redacted("policy", "transcript.expand"));
    expect(textOf(build(withheld, { expanded: true }))).toContain("Redacted.");
  });
});

describe("a block's status", () => {
  test("reports the outcome when it has one and never invents success", () => {
    // A status is not an outcome. A block with nothing to report is
    // informational, which says "this happened" rather than "this went well".
    expect(statusOfBlock(ofKind("process-exit"))).toBe("error");
    expect(statusOfBlock(ofKind("tool-progress"))).toBe("pending");
    expect(statusOfBlock(ofKind("file-change"))).toBe("informational");
  });

  test("does not read success out of attractive text", () => {
    // The fixture with "Build failed." above a non-zero exit exists for this.
    expect(statusOfBlock(ofKind("process-exit"))).not.toBe("success");
  });

  test("keeps cancellation and uncertainty apart from failure", () => {
    expect(statusOfBlock(ofKind("turn-outcome"))).toBe("cancelled");
    expect(statusOfBlock(ofKind("diagnostic"))).toBe("uncertain");
  });
});

describe("relative time", () => {
  const base = timestampFromEpochMilliseconds(Date.UTC(2026, 7, 1, 12, 0, 0));

  test("says nothing when there is nothing to be relative to", () => {
    expect(relativeTime(base, null)).toBe(null);
  });

  test("reads in the unit a person would use", () => {
    const at = (offset: number) =>
      relativeTime(timestampFromEpochMilliseconds(Date.UTC(2026, 7, 1, 12, 0, 0) - offset), base);
    expect(at(0)).toBe("now");
    expect(at(5_000)).toBe("5s ago");
    expect(at(90_000)).toBe("1m ago");
    expect(at(3 * 3_600_000)).toBe("3h ago");
  });

  test("says nothing rather than reporting a negative age", () => {
    const future = timestampFromEpochMilliseconds(Date.UTC(2026, 7, 1, 12, 5, 0));
    expect(relativeTime(future, base)).toBe(null);
  });
});
