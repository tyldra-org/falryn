/**
 * JSONC parsing for hand-edited configuration.
 *
 * Configuration files are written by people, so comments and a trailing comma
 * are ordinary rather than exceptional, and `JSON.parse` rejecting both would
 * make the format hostile for no benefit.
 *
 * A parse failure reports a line, a column, and an error code — never the text
 * at that position, and never a fragment of the file. The bytes of a file that
 * failed to parse are exactly the bytes most likely to hold a credential
 * someone pasted into the wrong place, and a parse error is the diagnostic most
 * likely to be copied into a bug report.
 */

import { type ParseError, parse, printParseErrorCode } from "jsonc-parser";

import { err, ok, type ParseFailure, type Result, type SourcePosition } from "../domain/index.ts";

/** Largest configuration file this build will read, in bytes. */
export const MAX_CONFIGURATION_FILE_BYTES = 256 * 1024;

/**
 * Converts a byte offset into a line and column.
 *
 * Counted rather than taken from the parser, which reports offsets only. Both
 * are one-based, matching every editor a user might open the file in.
 */
export function positionOf(text: string, offset: number): SourcePosition {
  const bounded = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < bounded; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: bounded - lineStart + 1 };
}

/**
 * Parses JSONC into a plain value.
 *
 * Only the first error is reported. A syntax error cascades — one missing brace
 * produces an error at every construct after it — so a list of them describes
 * the parser's recovery rather than the author's mistake.
 */
export function parseJsonc(text: string): Result<unknown, ParseFailure> {
  const errors: ParseError[] = [];
  const value = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  // A file of only comments and whitespace yields no value and complains only
  // that one was expected. That is an empty document — someone commented their
  // settings out — not a syntax error, and reporting it as malformed would send
  // a user hunting for a typo they did not make. A *truncated* document is
  // different: it yields a partial value alongside a structural complaint, so it
  // still falls through to the failure below.
  // Matched by name rather than by the parser's `ParseErrorCode`, which is an
  // ambient const enum this build's `verbatimModuleSyntax` cannot read.
  if (
    value === undefined &&
    errors.every((issue) => printParseErrorCode(issue.error) === "ValueExpected")
  ) {
    return ok(undefined);
  }

  const [first] = errors;
  if (first !== undefined) {
    return err({
      kind: "configuration-parse",
      // The parser's own code name, which describes structure only.
      code: printParseErrorCode(first.error),
      position: positionOf(text, first.offset),
    });
  }

  return ok(value);
}
