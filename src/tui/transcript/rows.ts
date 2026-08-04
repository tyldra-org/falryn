/**
 * A block, as rows a terminal can draw.
 *
 * This is the whole of the surface's *presentation* decision, and it is a pure
 * function so the decision can be asserted without a renderer. A row is a piece
 * of data — text, a colour token, a typography role, whether the text came from
 * outside Falryn — and `../components/transcript.tsx` turns rows into
 * renderables without deciding anything further.
 *
 * Three properties are load-bearing.
 *
 * **A collapsed block's height does not depend on the width.** The collapsed
 * form is at most two rows and each is truncated rather than wrapped, so
 * `collapsedRows` answers "how tall is this" without measuring a single glyph.
 * That is what makes a hundred-thousand-block history measurable in a frame:
 * the virtualizer needs every block's height to place the window, and a
 * measurement that had to wrap every block's text would be the reason a large
 * transcript is slow. Only an *expanded* block wraps, and the expanded set is
 * whatever the user has opened.
 *
 * **Truncation, redaction, and omission are three different notices.** Each
 * gets its own leading noun, its own status token, and therefore its own symbol
 * and word — so they are distinguishable on a monochrome terminal, which is the
 * only test of "visibly distinct" worth passing. Each also carries a route or an
 * explanation of why there is none. See `disclosureNotice`.
 *
 * **A secret block's content never reaches a row.** The projection already
 * withholds it, but this module refuses it a second time rather than trusting
 * that: a surface whose only protection is that its input happened to be
 * redacted is a surface that leaks the day a producer forgets.
 *
 * Nothing here holds React, OpenTUI, a clock, or a colour literal.
 */

import type { Timestamp } from "../../domain/index.ts";
import { timestampToEpochMilliseconds } from "../../domain/index.ts";
import type {
  BoundedText,
  Disclosure,
  ExpansionRoute,
  TranscriptBlock,
} from "../../presentation/index.ts";
import {
  boundedTextsOf,
  describeBlock,
  describeDisclosure,
  expansionRoutesFor,
  blockKey as keyOf,
  outcomeOf,
} from "../../presentation/index.ts";
import type { ColorToken, StatusToken, SymbolSet, TypographyRole } from "../theme/index.ts";

/**
 * One drawable row.
 *
 * A closed union rather than a bag of optional fields, because the two forms
 * are drawn by two different primitives: a `status` row is a `StatusMark`, which
 * guarantees a symbol *and* a word, and a `text` row is a `Line`. Collapsing
 * them into one shape would let a status become colour-only by omission.
 */
export type TranscriptRow =
  | {
      readonly kind: "text";
      /** Stable across revisions and re-renders. Derived from the block's anchor. */
      readonly key: string;
      readonly text: string;
      readonly color: ColorToken;
      readonly typography: TypographyRole;
      /** Content from outside Falryn: drawn through the escaping path. */
      readonly untrusted: boolean;
      /** Cells to indent. Structure, so an expansion reads as belonging to its block. */
      readonly indent: number;
    }
  | {
      readonly kind: "status";
      readonly key: string;
      readonly status: StatusToken;
      readonly label: string;
      readonly indent: number;
    };

/** How a bounded value is introduced when a block is expanded. */
type LabelledContent = {
  readonly label: string;
  readonly content: BoundedText;
};

export type RowsRequest = {
  readonly block: TranscriptBlock;
  readonly expanded: boolean;
  readonly selected: boolean;
  /** Cells the content may occupy, before the indent is taken out. */
  readonly columns: number;
  readonly symbols: SymbolSet;
  /**
   * Wrapping, supplied rather than imported.
   *
   * The caller owns the bounded cache that makes wrapping affordable, and a
   * module that reached for the measurement itself would either bypass that
   * cache or become a second owner of it.
   */
  readonly wrap: (text: string, width: number) => readonly string[];
  /**
   * What a route is called right now, including the key that runs it.
   *
   * Injected because a route's key comes from the keymap plan, and a row
   * builder that knew the keymap would be a second resolver of what a key
   * currently does.
   */
  readonly describeRoute: (route: ExpansionRoute) => string;
  /**
   * The moment the transcript's newest block occurred, or `null`.
   *
   * Relative time is measured against the transcript rather than a clock, so
   * the same projection renders the same rows every time — which is what makes
   * a frame test an assertion rather than a race. See `relativeTime` for why
   * this is an age and deliberately not a duration.
   */
  readonly relativeTo: Timestamp | null;
};

/** Indent applied to everything an expansion reveals. */
export const EXPANSION_INDENT = 2;

/**
 * Rows a collapsed block occupies.
 *
 * Width-independent by construction, which is the property the virtualizer
 * depends on. The headline is always drawn; the notice row is drawn when the
 * block has something withheld or somewhere to go.
 */
export function collapsedRows(block: TranscriptBlock): number {
  return hasNotice(block) ? 2 : 1;
}

function hasNotice(block: TranscriptBlock): boolean {
  return primaryDisclosure(block) !== null || expansionRoutesFor(block).length > 0;
}

/**
 * The disclosure the collapsed form reports.
 *
 * The first value that is not complete, in the order `boundedTextsOf` declares —
 * which puts the summary first and the block's own content after it. One rather
 * than all of them: a collapsed row reporting three separate clippings is a
 * paragraph, and the expansion is where the detail belongs.
 */
function primaryDisclosure(block: TranscriptBlock): Disclosure | null {
  for (const bounded of boundedTextsOf(block)) {
    if (bounded.disclosure.kind !== "complete") {
      return bounded.disclosure;
    }
  }
  return null;
}

/**
 * The status a block wears.
 *
 * The outcome first, because that is the fact a reader is looking for, and the
 * lifecycle only when there is no outcome to report. Nothing here invents
 * success: a block with no outcome and a final status is `informational`, which
 * says "this happened" rather than "this went well".
 */
export function statusOfBlock(block: TranscriptBlock): StatusToken {
  const outcome = outcomeOf(block);
  if (outcome === null) {
    return block.status === "in-progress" ? "pending" : "informational";
  }
  switch (outcome.kind) {
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "cancelled":
      return "cancelled";
    case "timed-out":
      return "warning";
    case "uncertain":
      return "uncertain";
  }
}

/**
 * How long ago a block happened, in words, or `null`.
 *
 * An age and not a duration, and the difference is worth stating rather than
 * hiding behind a friendlier label. A block carries one timestamp: a revision
 * replaces it, so a tool call that ran for a minute keeps only the moment it
 * finished, and the start it began at is not in the projection at all. Reporting
 * "1m" as a duration would be a number the surface made up. What this reports is
 * the block's age relative to the newest block in the same transcript, which is
 * a fact both timestamps actually support.
 */
export function relativeTime(at: Timestamp, relativeTo: Timestamp | null): string | null {
  if (relativeTo === null) {
    return null;
  }
  const milliseconds = timestampToEpochMilliseconds(relativeTo) - timestampToEpochMilliseconds(at);
  if (milliseconds < 0) {
    // A block newer than the newest one is a projection that is not ordered by
    // time. Saying nothing is better than reporting a negative age.
    return null;
  }
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 1) {
    return "now";
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  return `${Math.floor(minutes / 60)}h ago`;
}

export type DisclosureNotice = {
  readonly status: StatusToken;
  readonly text: string;
};

/**
 * What a disclosure says, and how it says it.
 *
 * Three nouns, three status tokens. `Truncated` is informational because the
 * content is intact somewhere; `Redacted` is a warning because something exists
 * that the reader is not being shown; `Omitted` is uncertain because nobody
 * looked, and an interface that rendered "nothing was collected" as a calm
 * absence would let a bug read as an empty result.
 *
 * Every notice carries a route or the sentence explaining why there is none —
 * never silence, which is what makes "expand for more" a promise the build can
 * keep.
 *
 * The route comes before the quantity, and that ordering is the one thing here
 * chosen by looking at a terminal. A collapsed notice is one truncated line, so
 * whatever sits last is what falls off a narrow window — and the exact byte and
 * line counts are the part a reader can afford to lose, while the action they
 * can take is not. Detail before action reads better and degrades worse.
 */
export function disclosureNotice(
  disclosure: Disclosure,
  describeRoute: (route: ExpansionRoute) => string,
): DisclosureNotice | null {
  switch (disclosure.kind) {
    case "complete":
      return null;
    case "truncated":
      return {
        status: "informational",
        text: `Truncated. ${describeRoute(disclosure.route)} ${describeDisclosure(disclosure)}`,
      };
    case "redacted":
      return {
        status: "warning",
        text: `Redacted. ${
          disclosure.route === null
            ? "There is no expansion that reveals it."
            : describeRoute(disclosure.route)
        } ${describeDisclosure(disclosure)}`,
      };
    case "omitted":
      return {
        status: "uncertain",
        text: `Omitted. ${
          disclosure.route === null
            ? "There is nothing behind it to open."
            : describeRoute(disclosure.route)
        } ${describeDisclosure(disclosure)}`,
      };
  }
}

/**
 * The rows one block draws.
 *
 * Collapsed is the headline and, when there is something to say, a notice.
 * Expanded adds the block's own content, its provenance, and its related
 * events — each of which is a fact the projection already carries rather than
 * something this module reconstructs.
 */
export function rowsForBlock(request: RowsRequest): readonly TranscriptRow[] {
  const { block, symbols } = request;
  const key = keyOf(block.anchor);
  const rows: TranscriptRow[] = [headline(request, key)];

  const notice = collapsedNotice(request);
  if (notice !== null) {
    rows.push({
      kind: "status",
      key: `${key}:notice`,
      status: notice.status,
      label: notice.text,
      indent: EXPANSION_INDENT,
    });
  }

  if (!request.expanded) {
    return rows;
  }

  for (const [index, entry] of contentOf(block).entries()) {
    rows.push({
      kind: "text",
      key: `${key}:label:${index}`,
      text: `${symbols.bullet} ${entry.label}`,
      color: "mutedForeground",
      typography: "label",
      untrusted: false,
      indent: EXPANSION_INDENT,
    });
    rows.push(...contentRows(request, key, index, entry.content));
  }

  rows.push(...provenanceRows(request, key));
  return rows;
}

/**
 * The one row every block always draws.
 *
 * Identity, summary, and age on one truncated line. Truncated rather than
 * wrapped so the collapsed height is a constant — see this module's header.
 */
function headline(request: RowsRequest, key: string): TranscriptRow {
  const { block, symbols } = request;
  const marker = expansionMarker(request);
  const age = relativeTime(block.occurredAt, request.relativeTo);
  const parts = [
    describeBlock(block),
    summaryText(block),
    ...(age === null ? [] : [age]),
    // A word, not only a glyph. The symbol set draws `focus` and `collapsed` as
    // the same character, so a selection marker alone would be indistinguishable
    // from "this can be opened" — and on a monochrome terminal a highlight is
    // not available to break the tie either.
    ...(request.selected ? ["selected"] : []),
  ];
  return {
    kind: "status",
    key: `${key}:headline`,
    status: statusOfBlock(block),
    label: `${marker} ${parts.join(` ${symbols.separator} `)}`,
    indent: 0,
  };
}

/**
 * The summary, as text a row may carry.
 *
 * A secret block's summary is still shown — a withheld block is not an
 * invisible one, and the summary is the part that says what happened.
 */
function summaryText(block: TranscriptBlock): string {
  return block.summary.text === ""
    ? describeDisclosure(block.summary.disclosure)
    : block.summary.text;
}

/** Whether opening this block would reveal anything it is not already showing. */
function hasExpansion(block: TranscriptBlock): boolean {
  return contentOf(block).length > 0;
}

/**
 * The glyph that says whether a block can be opened, and whether it is.
 *
 * A space rather than a symbol for a block with nothing to reveal: a marker
 * beside a block that cannot expand is an affordance the interface does not
 * have.
 */
function expansionMarker(request: RowsRequest): string {
  if (!hasExpansion(request.block)) {
    return " ";
  }
  return request.expanded ? request.symbols.expanded : request.symbols.collapsed;
}

/**
 * The collapsed notice: what is withheld, or where a reader can go.
 *
 * The disclosure wins when there is one, because "part of this is missing" is
 * more urgent than "there is more to see". When nothing is withheld but routes
 * exist, the routes are the next useful action.
 */
function collapsedNotice(request: RowsRequest): DisclosureNotice | null {
  const disclosure = primaryDisclosure(request.block);
  if (disclosure !== null) {
    return disclosureNotice(disclosure, request.describeRoute);
  }
  const routes = expansionRoutesFor(request.block);
  if (routes.length === 0) {
    return null;
  }
  return {
    status: "informational",
    text: routes.map((route) => request.describeRoute(route)).join(" "),
  };
}

/**
 * What a block reveals when it is expanded, labelled.
 *
 * Exhaustive over the union so a kind that gains content cannot be expanded into
 * a blank region. The summary is deliberately absent: it is already on the
 * headline, and repeating it is the first row of an expansion telling the reader
 * nothing they did not have.
 */
function contentOf(block: TranscriptBlock): readonly LabelledContent[] {
  switch (block.kind) {
    case "user-input":
      return [{ label: "message", content: block.text }];
    case "model-text":
      return [{ label: "response", content: block.text }];
    case "model-reasoning":
      return [{ label: "reasoning", content: block.text }];
    case "model-outcome":
    case "turn-outcome":
      return [];
    case "tool-request":
      return [{ label: "input", content: block.input }];
    case "tool-progress":
      return [{ label: "progress", content: block.note }];
    case "tool-result":
      return [{ label: "output", content: block.output }];
    case "process-stream":
      return [{ label: block.channel, content: block.output }];
    case "process-exit":
      return [];
    case "file-change":
      return [
        { label: "path", content: block.path },
        { label: "detail", content: block.detail },
      ];
    case "repository-activity":
      return [{ label: "detail", content: block.detail }];
    case "task-progress":
      return [{ label: "task", content: block.label }];
    case "notice":
      return [{ label: "notice", content: block.note }];
    case "diagnostic":
      return [{ label: "diagnostic", content: block.note }];
    case "artifact":
      return [];
  }
}

/**
 * The rows one labelled value draws.
 *
 * Content from a canonical source, wrapped to the region and drawn as untrusted
 * text. A value that is not complete draws its notice instead of pretending the
 * empty string it carries is the content.
 */
function contentRows(
  request: RowsRequest,
  key: string,
  index: number,
  content: BoundedText,
): readonly TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  const width = Math.max(1, request.columns - EXPANSION_INDENT * 2);

  // The second refusal. See this module's header: the projection withholds a
  // secret block's content, and this declines to draw it even if one arrives
  // holding text.
  if (request.block.sensitivity === "secret") {
    rows.push({
      kind: "status",
      key: `${key}:secret:${index}`,
      status: "warning",
      label: "Withheld. This block is secret and has no expansion that reveals it.",
      indent: EXPANSION_INDENT * 2,
    });
    return rows;
  }

  if (content.text !== "") {
    for (const [line, text] of wrapAll(request, content.text, width).entries()) {
      rows.push({
        kind: "text",
        key: `${key}:content:${index}:${line}`,
        text,
        color: "foreground",
        typography: "body",
        untrusted: true,
        indent: EXPANSION_INDENT * 2,
      });
    }
  }

  const notice = disclosureNotice(content.disclosure, request.describeRoute);
  if (notice !== null) {
    rows.push({
      kind: "status",
      key: `${key}:disclosure:${index}`,
      status: notice.status,
      label: notice.text,
      indent: EXPANSION_INDENT * 2,
    });
  }
  return rows;
}

/** Every wrapped line of a multi-line value, in order. */
function wrapAll(request: RowsRequest, text: string, width: number): readonly string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    // An empty line wraps to nothing, and dropping it would close the gap a
    // producer put between two paragraphs.
    const wrapped = paragraph === "" ? [""] : request.wrap(paragraph, width);
    lines.push(...wrapped);
  }
  return lines;
}

/**
 * Where the block came from, and what it is related to.
 *
 * Provenance is part of the expansion the canonical contract names, and every
 * field here is one the projection already carries: nothing is derived, looked
 * up, or guessed.
 */
function provenanceRows(request: RowsRequest, key: string): readonly TranscriptRow[] {
  const { block } = request;
  const facts = [
    `source ${block.source}`,
    `sensitivity ${block.sensitivity}`,
    `generation ${block.renderGeneration}`,
    ...(block.invocationId === null ? [] : [`invocation ${block.invocationId}`]),
    ...(block.artifactIds.length === 0 ? [] : [`artifacts ${block.artifactIds.length}`]),
  ];
  return [
    {
      kind: "text",
      key: `${key}:provenance`,
      text: facts.join(`  ${request.symbols.separator}  `),
      color: "mutedForeground",
      typography: "muted",
      untrusted: true,
      indent: EXPANSION_INDENT,
    },
  ];
}
