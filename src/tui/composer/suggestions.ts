/**
 * The composer's suggestion list (#1206): one surface for every mention trigger.
 *
 * A source declares its trigger and answers a bounded query; this module owns what
 * the list shows and which row is selected. Opening and closing follow the draft and
 * cursor, so they are decided by the pure composer state. Querying is the only
 * asynchronous part, and it is owned by the shell runtime, which supersedes older
 * requests and drops late answers by request number.
 */

import type {
  ComposerTokenPick,
  MentionTokenKind,
  MentionTrigger,
} from "../../domain/context/composer-mentions.ts";

/** Rows the list shows at once; a narrow terminal shows fewer. */
export const SUGGESTION_ROWS = 8;
export const SUGGESTION_ROWS_NARROW = 5;
/** Columns below which the list is narrow. */
export const SUGGESTION_NARROW_COLUMNS = 60;
/** How long typing may pause before a query is sent. */
export const SUGGESTION_DEBOUNCE_MS = 50;

export type SuggestionRow = {
  /** Stable within one page. */
  readonly id: string;
  readonly label: string;
  readonly kind: MentionTokenKind;
  /** Kind, source and scope, as one short line. */
  readonly detail: string;
  /** Whether the row's label is exactly the typed query. */
  readonly exact: boolean;
  readonly unavailable: { readonly reason: string; readonly repair: string | null } | null;
  readonly pick: ComposerTokenPick;
};

export type SuggestionPage = {
  readonly rows: readonly SuggestionRow[];
  readonly total: number;
  /** A source that could not answer says so here, while other rows still list. */
  readonly notice: string | null;
};

/** One trigger's source of rows. Listing reads metadata only and starts nothing. */
export type ComposerSuggestionSource = {
  readonly trigger: MentionTrigger;
  query(query: string, signal: AbortSignal): Promise<SuggestionPage>;
};

export type ComposerSuggestions = {
  readonly trigger: MentionTrigger;
  /** Offset of the trigger character in the draft. */
  readonly start: number;
  /** Offset of the cursor when the query was taken. */
  readonly end: number;
  readonly query: string;
  /** Monotonic; a result for any other number is late and ignored. */
  readonly request: number;
  readonly status: "loading" | "ready" | "failed";
  readonly rows: readonly SuggestionRow[];
  readonly total: number;
  readonly selected: number;
  readonly notice: string | null;
};

/** The rows the list can show in this many columns. */
export function visibleSuggestionRows(columns: number): number {
  return columns < SUGGESTION_NARROW_COLUMNS ? SUGGESTION_ROWS_NARROW : SUGGESTION_ROWS;
}

/**
 * Rows the list occupies on screen: its rows plus one hint line, or nothing when it
 * is closed or has nothing to show. The layout reserves exactly this.
 */
export function suggestionListRows(
  suggestions: ComposerSuggestions | null,
  columns: number,
): number {
  if (suggestions === null) return 0;
  if (suggestions.rows.length === 0 && suggestions.notice === null) return 0;
  const shown = Math.min(suggestions.rows.length, visibleSuggestionRows(columns));
  return shown + (suggestions.notice === null ? 0 : 1) + 1;
}

/** The window of rows around the selection. */
export function suggestionWindow(
  suggestions: ComposerSuggestions,
  columns: number,
): { readonly first: number; readonly rows: readonly SuggestionRow[] } {
  const size = visibleSuggestionRows(columns);
  const first = suggestions.selected < size ? 0 : suggestions.selected - size + 1;
  return { first, rows: suggestions.rows.slice(first, first + size) };
}
