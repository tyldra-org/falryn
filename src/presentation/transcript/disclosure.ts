/**
 * Truncation, redaction, and omission — three different things.
 *
 * Collapsing them is the failure this module exists to prevent, and it is an
 * easy one to commit: all three end with a user seeing less than the whole, so
 * a single `truncated: boolean` looks sufficient right up until someone asks
 * what happened to the rest. The three answers are not interchangeable.
 *
 * - **Truncated** means the content is intact somewhere and this view holds a
 *   prefix of it. It carries exact counts and a route to the rest.
 * - **Redacted** means the content exists and is deliberately withheld. There
 *   may be no route at all, and saying "expand for more" would be a lie.
 * - **Omitted** means the content was never collected. A route would point at
 *   nothing.
 *
 * A user who cannot tell "there is more" from "you may not see this" from
 * "nobody looked" cannot tell a large file from a secret from a bug. So the
 * union below is closed, each variant carries what only it can carry, and
 * `describeDisclosure` is exhaustive — a new variant stops compiling until it
 * has words of its own.
 *
 * Nothing here renders. A disclosure is data about content, and how it *looks*
 * is the transcript surface's problem.
 */

import { sanitizeTerminalText } from "../../domain/index.ts";

/**
 * The routes a view may offer for content it is not showing in full.
 *
 * A closed union rather than a free string, for the reason the projections
 * contract already states about expansion routes: a route is a promise the
 * running build has to keep, and a phrase nobody dispatches is a promise
 * nobody checks. These resolve to commands in the transcript surface; this
 * module only guarantees that a bounded value names one of them.
 */
export const EXPANSION_ROUTES = [
  /** Show the rest of this content in place. */
  "transcript.expand",
  /** Open the artifact the content was clipped from. */
  "transcript.open-artifact",
  /** Show the diagnostics behind a failure. */
  "transcript.show-diagnostics",
] as const;

export type ExpansionRoute = (typeof EXPANSION_ROUTES)[number];

/**
 * How much content there is, in the units a user can act on.
 *
 * Bytes and lines are always meaningful. `results` is not — a search has a
 * result count and a paragraph of model text does not — so it is nullable
 * rather than zero. Reporting "0 results" for text that was never a search is
 * a fact the projection made up.
 */
export type Extent = {
  readonly bytes: number;
  readonly lines: number;
  readonly results: number | null;
};

export type Disclosure =
  | { readonly kind: "complete" }
  /** A prefix. The rest exists and the route reaches it. */
  | {
      readonly kind: "truncated";
      readonly shown: Extent;
      readonly total: Extent;
      readonly route: ExpansionRoute;
    }
  /** Withheld on purpose. A route is optional because there may be nowhere to go. */
  | { readonly kind: "redacted"; readonly reason: string; readonly route: ExpansionRoute | null }
  /** Never collected. There is nothing behind it to route to. */
  | { readonly kind: "omitted"; readonly reason: string; readonly route: ExpansionRoute | null };

/** Text together with what happened to the part that is not here. */
export type BoundedText = {
  /** Sanitized. A value from a file, a provider, or a process is data. */
  readonly text: string;
  readonly disclosure: Disclosure;
};

/**
 * What the projection will hold for one block.
 *
 * A memory bound, not a display bound. The surface clips further to fit a
 * terminal; this is the point past which retaining more would cost more than
 * the content is worth to anyone. A single block holding a hundred-megabyte
 * command output is how a transcript becomes the reason a session dies.
 */
export type RetentionLimits = {
  readonly bytes: number;
  readonly lines: number;
};

export const RETENTION_LIMITS: RetentionLimits = {
  bytes: 64 * 1_024,
  lines: 512,
};

const ENCODER = new TextEncoder();

/**
 * Sanitizes text that is allowed to have lines.
 *
 * `sanitizeTerminalText` escapes newlines along with every other control
 * character, and it is right to: everywhere it was written for puts a value on
 * a line beside a label, where a newline in the value forges a line the
 * renderer never wrote. A transcript is the one place that reasoning does not
 * hold. Model prose, command output, and diffs are multi-line by nature, and a
 * transcript rendering them as `\x0a` between every line would be unreadable in
 * exactly the case it exists for.
 *
 * So the line structure survives and nothing else does. The escaping rule is
 * still the domain's, applied to each line — this module does not write a
 * second, more permissive one, which is the thing that would actually be
 * dangerous. A newline here is structure; every other control character,
 * escape introducer, and unpaired surrogate is still neutralized by the one
 * owner of that rule.
 *
 * Line endings are normalized first, so a carriage return does not survive as a
 * visible `\x0d` at the end of every line of a file written on Windows.
 */
function sanitizeBlockText(text: string): string {
  return text.replaceAll(/\r\n?/g, "\n").split("\n").map(sanitizeTerminalText).join("\n");
}

/**
 * Measures content the way a user would ask about it.
 *
 * Bytes rather than string length, because "how big is this" is answered in
 * the unit the file had, not in UTF-16 code units nobody chose.
 */
export function measureExtent(text: string, results: number | null = null): Extent {
  return {
    bytes: ENCODER.encode(text).length,
    // An empty string is zero lines, not one. A block reporting "1 line" for
    // nothing at all is the same lie as "0 results" for a paragraph.
    lines: text === "" ? 0 : text.split("\n").length,
    results,
  };
}

/**
 * Sanitizes and bounds untrusted text.
 *
 * The order matters: sanitize first, then measure. Measuring the raw text and
 * clipping the sanitized text reports a count for content that was never
 * retained — and an escape sequence expands to several visible characters when
 * it is de-fanged, so the two differ by more than a rounding error.
 */
export function bound(
  raw: string,
  limits: RetentionLimits = RETENTION_LIMITS,
  results: number | null = null,
): BoundedText {
  const text = sanitizeBlockText(raw);
  const total = measureExtent(text, results);
  if (total.lines <= limits.lines && total.bytes <= limits.bytes) {
    return { text, disclosure: { kind: "complete" } };
  }
  const kept = clip(text, limits);
  return {
    text: kept,
    disclosure: {
      kind: "truncated",
      // The shown half carries no result count. How many of a search's results
      // survived a byte clip is not recoverable from the clipped text, and
      // guessing it would put an invented number beside two measured ones.
      shown: measureExtent(kept),
      total,
      route: "transcript.expand",
    },
  };
}

/** Content that exists and is deliberately withheld. */
export function redacted(reason: string, route: ExpansionRoute | null = null): BoundedText {
  return { text: "", disclosure: { kind: "redacted", reason, route } };
}

/** Content that was never collected. */
export function omitted(reason: string, route: ExpansionRoute | null = null): BoundedText {
  return { text: "", disclosure: { kind: "omitted", reason, route } };
}

/** Text short enough that nothing happened to it. */
export function complete(raw: string): BoundedText {
  return { text: sanitizeBlockText(raw), disclosure: { kind: "complete" } };
}

function clip(text: string, limits: RetentionLimits): string {
  const lines = text.split("\n");
  const byLines = lines.length > limits.lines ? lines.slice(0, limits.lines).join("\n") : text;
  return clipToBytes(byLines, limits.bytes);
}

/**
 * Cuts to a byte budget without splitting a character.
 *
 * Iterating code points rather than slicing the string: a slice by index cuts
 * UTF-16 units, which halves an astral character into two unpaired surrogates —
 * content that is no longer text, produced by the function whose job was to
 * keep it readable.
 */
function clipToBytes(text: string, maxBytes: number): string {
  if (ENCODER.encode(text).length <= maxBytes) {
    return text;
  }
  let used = 0;
  let kept = "";
  for (const character of text) {
    const size = ENCODER.encode(character).length;
    if (used + size > maxBytes) {
      break;
    }
    used += size;
    kept += character;
  }
  return kept;
}

/** Whether the whole of the content is present. */
export function isComplete(disclosure: Disclosure): boolean {
  return disclosure.kind === "complete";
}

/**
 * The route a disclosure offers, or `null` when it honestly has none.
 *
 * Only truncation always has one. Offering a route for a redaction the user
 * cannot lift, or for content nobody collected, is an interface promising
 * something no command can deliver.
 */
export function routeOf(disclosure: Disclosure): ExpansionRoute | null {
  switch (disclosure.kind) {
    case "complete":
      return null;
    case "truncated":
      return disclosure.route;
    case "redacted":
    case "omitted":
      return disclosure.route;
  }
}

/**
 * What happened to the content, in words.
 *
 * Words rather than a symbol or a colour: this is the sentence that survives a
 * monochrome terminal, and it is the one a user most needs when the content
 * they wanted is not on screen.
 */
export function describeDisclosure(disclosure: Disclosure): string {
  switch (disclosure.kind) {
    case "complete":
      return "Complete.";
    case "truncated": {
      const lines = disclosure.total.lines - disclosure.shown.lines;
      const bytes = disclosure.total.bytes - disclosure.shown.bytes;
      const results =
        disclosure.total.results === null ? "" : ` of ${disclosure.total.results} results`;
      return `Showing part${results}; ${lines} more lines and ${bytes} more bytes are not shown.`;
    }
    case "redacted":
      return `Withheld: ${disclosure.reason}`;
    case "omitted":
      return `Not collected: ${disclosure.reason}`;
  }
}
