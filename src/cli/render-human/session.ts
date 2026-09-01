/** Shared layout, bounds, and styling for human CLI projections. */

import {
  type ColorLevel,
  MAX_RELATED_ERRORS,
  type SymbolSupport,
  truncateToWidth,
  wrapToWidth,
} from "../../domain/index.ts";
import type { RunCommandResult } from "../commands.ts";
import { MAX_WARNINGS } from "../result.ts";

/**
 * The layout width used when the handle reported none.
 *
 * This does not contradict the control that forbids `columns ?? 80` in
 * `domain/terminal.ts`: that control governs *deriving a fact* about a handle,
 * and a non-terminal treated as a narrow terminal is a fact that is wrong.
 * Choosing a width to lay text out in when nothing reported one is a rendering
 * decision, and this module is the one entitled to make it.
 */
export const DEFAULT_DISPLAY_COLUMNS = 80;

/** The narrowest width this renderer will lay out to. Narrower is clamped. */
export const MIN_DISPLAY_COLUMNS = 20;

/** The two texts one run produces, each destined for the handle that owns it. */
export type RenderedText = {
  /** The selected result format. Written to stdout. Empty when there is none. */
  readonly result: string;
  /** Status, warnings, notices, and errors. Written to stderr. */
  readonly diagnostics: string;
};

export type HumanRenderRequest = {
  readonly result: RunCommandResult;
  /** Already resolved against `--color` and the selected format by the caller. */
  readonly color: ColorLevel;
  readonly symbols: SymbolSupport;
  /** From `capabilities.stdout.columns`. `null` selects {@link DEFAULT_DISPLAY_COLUMNS}. */
  readonly columns: number | null;
  readonly verbose: boolean;
};

/* -------------------------------------------------------------------------- */
/* Bounds                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * How much of each list this renderer will show.
 *
 * Two sets rather than one scaled number, because `--verbose` is a real
 * expansion route and a route that only widened things a little would still
 * leave the reader without the answer they asked for.
 */
export type DisplayBounds = {
  readonly values: number;
  readonly sources: number;
  readonly issues: number;
  readonly warnings: number;
  readonly omissions: number;
  readonly truncations: number;
  readonly errors: number;
  readonly related: number;
  /** Display width one rendered value may occupy before it is shortened. */
  readonly field: number;
};

export const NORMAL_BOUNDS: DisplayBounds = {
  values: 40,
  sources: 20,
  issues: 10,
  warnings: 8,
  omissions: 8,
  truncations: 8,
  errors: 5,
  // Folded entirely when concise: a primary failure with its own detail is
  // what a reader needs first, and its companions are what `--verbose` is for.
  related: 0,
  field: 60,
};

const VERBOSE_BOUNDS: DisplayBounds = {
  values: 1_000,
  sources: 200,
  issues: 200,
  warnings: MAX_WARNINGS,
  omissions: 200,
  truncations: 200,
  errors: 100,
  related: MAX_RELATED_ERRORS,
  field: 400,
};

/* -------------------------------------------------------------------------- */
/* Style                                                                       */
/* -------------------------------------------------------------------------- */

/** Select Graphic Rendition sequences. Emitted only when colour is permitted. */
const SGR = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
} as const;

export type Tone = "good" | "bad" | "warn" | "muted" | "plain";

const TONE_CODE: Readonly<Record<Tone, string>> = {
  good: SGR.green,
  bad: SGR.red,
  warn: SGR.yellow,
  muted: SGR.dim,
  plain: SGR.bold,
};

/**
 * The characters this renderer draws with.
 *
 * Every mark is paired with a word wherever it appears, so a terminal that
 * loses either the colour or the repertoire loses decoration rather than
 * meaning.
 */
export type Glyphs = {
  readonly dash: string;
  readonly ellipsis: string;
  readonly completed: string;
  readonly failed: string;
  readonly cancelled: string;
  readonly timedOut: string;
  readonly uncertain: string;
  readonly warning: string;
  readonly omission: string;
  readonly note: string;
};

const UNICODE_GLYPHS: Glyphs = {
  dash: "—",
  ellipsis: "…",
  completed: "✓",
  failed: "✗",
  cancelled: "⊘",
  timedOut: "⧖",
  uncertain: "?",
  warning: "!",
  omission: "~",
  note: "·",
};

const ASCII_GLYPHS: Glyphs = {
  dash: "--",
  ellipsis: "...",
  completed: "[ok]",
  failed: "[x]",
  cancelled: "[-]",
  timedOut: "[~]",
  uncertain: "[?]",
  warning: "[!]",
  omission: "[~]",
  note: "-",
};

/* -------------------------------------------------------------------------- */
/* Session                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One render in progress.
 *
 * `shortened` is the only mutable thing here: a value trimmed to fit cannot
 * carry a sentence explaining itself, so the count is collected while the
 * payload is laid out and reported once, afterwards, as a notice.
 */
export type Session = {
  readonly color: ColorLevel;
  readonly glyphs: Glyphs;
  readonly columns: number;
  readonly verbose: boolean;
  readonly bounds: DisplayBounds;
  /** Values this renderer shortened, for any reason. */
  shortened: number;
  /**
   * Values the concise *bound* shortened rather than the terminal's width.
   *
   * The two have different escapes, and only one of them is `--verbose`. A
   * value cut because the terminal is narrow is not made whole by a flag, and
   * offering one there would name a route that does not answer.
   */
  boundedByField: number;
};

export function sessionFor(request: HumanRenderRequest): Session {
  return {
    color: request.color,
    glyphs: request.symbols === "unicode" ? UNICODE_GLYPHS : ASCII_GLYPHS,
    columns: layoutWidth(request.columns),
    verbose: request.verbose,
    bounds: request.verbose ? VERBOSE_BOUNDS : NORMAL_BOUNDS,
    shortened: 0,
    boundedByField: 0,
  };
}

/**
 * The width to lay out in.
 *
 * A handle that reported nothing gets the declared default; one that reported
 * something unusably narrow is clamped rather than looped on, because this is a
 * pure function and a zero would otherwise be a wrap that never terminates.
 */
function layoutWidth(columns: number | null): number {
  if (columns === null || !Number.isFinite(columns)) {
    return DEFAULT_DISPLAY_COLUMNS;
  }
  return Math.max(MIN_DISPLAY_COLUMNS, Math.floor(columns));
}

export function paint(session: Session, tone: Tone, text: string): string {
  if (session.color === "none" || tone === "plain") {
    return text;
  }
  return `${TONE_CODE[tone]}${text}${SGR.reset}`;
}

/** One sentence laid out as however many lines the width allows. */
export function sentence(session: Session, text: string, indent = ""): readonly string[] {
  return wrapToWidth(text, session.columns - indent.length).map((line) => `${indent}${line}`);
}

/**
 * A label with its text wrapped underneath it, aligned to the label's width.
 *
 * For a list that has to fit rather than be shortened: a class name cut in half
 * names nothing, while the same list over two lines still reads.
 */
export function hanging(session: Session, label: string, text: string): readonly string[] {
  const continuation = " ".repeat(label.length);
  return wrapToWidth(text, session.columns - label.length).map(
    (line, index) => `${index === 0 ? label : continuation}${line}`,
  );
}

/** A value shortened to a width, counted so the run can say that it was. */
export function fit(session: Session, text: string, width: number): string {
  const limit = Math.max(4, Math.min(width, session.bounds.field));
  const shortened = truncateToWidth(text, limit, session.glyphs.ellipsis);
  if (shortened !== text) {
    session.shortened += 1;
    if (session.bounds.field < width) {
      session.boundedByField += 1;
    }
  }
  return shortened;
}

export function joinLines(lines: readonly string[]): string {
  return lines.join("\n");
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

/* -------------------------------------------------------------------------- */
/* Bounded lists                                                               */
/* -------------------------------------------------------------------------- */

export type Bounded<Item> = { readonly shown: readonly Item[]; readonly dropped: number };

export function bound<Item>(items: readonly Item[], limit: number): Bounded<Item> {
  if (items.length <= limit) {
    return { shown: items, dropped: 0 };
  }
  return { shown: items.slice(0, Math.max(0, limit)), dropped: items.length - Math.max(0, limit) };
}

/**
 * What a shortened list says about what it dropped.
 *
 * Always names a route, and only one this build honours: `--verbose` while it
 * is unset, and an explicit statement that nothing wider exists once it is.
 */
export function droppedNotice(
  session: Session,
  dropped: number,
  noun: string,
  shown: number,
): string {
  const what = `${shown} of ${shown + dropped} ${plural(shown + dropped, noun)}`;
  return session.verbose
    ? `Showing ${what}; this build has no wider form.`
    : `Showing ${what}; run with --verbose to see the rest.`;
}
