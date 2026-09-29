/**
 * Composer mention tokens (#1206): the bound token model shared by `/`, `$` and `@`.
 *
 * A token is a user's pick from the composer's suggestion list. It binds the exact
 * identity that was picked; its label is only how the pick reads in the draft. Text
 * alone never becomes a token: pasted, dictated, generated, template and model text
 * stays text, so this module works on picks and on text ranges, never on a parser
 * that promotes words.
 *
 * Pure. The composer state owns the token list; the view keeps each token atomic
 * through the editor's own ranges and reports where they moved.
 */

export const MENTION_TRIGGERS = ["/", "$", "@"] as const;
export type MentionTrigger = (typeof MENTION_TRIGGERS)[number];

export const MENTION_TOKEN_KINDS = [
  "skill",
  "package",
  "mcp-server",
  "template",
  "file",
  "directory",
  "symbol",
  "resource",
] as const;
export type MentionTokenKind = (typeof MENTION_TOKEN_KINDS)[number];

export const MENTION_TOKEN_LIMITS = Object.freeze({
  /** Tokens of every kind in one draft. */
  draft: 64,
  /** `$` capability tokens in one prompt. */
  capabilities: 8,
  /** Skill tokens in one prompt: the instruction owner's per-request body limit. */
  skills: 4,
  labelCharacters: 128,
  identityBytes: 512,
  queryCharacters: 128,
});

/** One bound pick in the draft. `start`/`end` are UTF-16 offsets into the draft text. */
export type ComposerToken = {
  readonly id: string;
  readonly trigger: MentionTrigger;
  readonly kind: MentionTokenKind;
  /** The exact picked identity, checked again when the prompt is sent. */
  readonly identity: string;
  /** How the pick reads in the draft, trigger included. Presentation only. */
  readonly label: string;
  /** Where the pick came from, for the list, the receipt and screen readers. */
  readonly source: string;
  /** The source generation the pick was made against. */
  readonly generation: string;
  readonly start: number;
  readonly end: number;
};

/** A token before it has a place in the text. */
export type ComposerTokenPick = Omit<ComposerToken, "id" | "start" | "end">;

/** An open trigger: the character and what has been typed after it, up to the cursor. */
export type MentionTriggerMatch = {
  readonly trigger: MentionTrigger;
  /** Offset of the trigger character. */
  readonly start: number;
  /** Offset of the cursor; the query is `text.slice(start + 1, end)`. */
  readonly end: number;
  readonly query: string;
};

const OPENERS = new Set(["(", "[", "{", '"', "'"]);
const QUERY = /^[\p{L}\p{N}._:/-]*$/u;
/** Common environment variables that `$NAME` almost always means in prose and shell snippets. */
const ENVIRONMENT_NAMES = new Set([
  "HOME",
  "PATH",
  "USER",
  "SHELL",
  "PWD",
  "OLDPWD",
  "TMPDIR",
  "LANG",
  "TERM",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "HOSTNAME",
  "LOGNAME",
  "CI",
]);

/**
 * Whether a `$` query is shell syntax rather than a capability name. The list never
 * opens for these, so writing a shell snippet does not flash suggestions.
 */
export function isShellLikeDollarQuery(query: string): boolean {
  const first = query[0];
  if (first === undefined) return false;
  if (/[0-9$?!#*@_{(-]/u.test(first)) return true;
  const name = query.split(":")[0] ?? "";
  return name.length > 0 && name === name.toUpperCase() && ENVIRONMENT_NAMES.has(name);
}

/**
 * The trigger the cursor is completing, or null.
 *
 * A trigger counts at the start of the draft or after whitespace or an opening
 * bracket or quote. After a letter, a digit, `_`, or (for `/`) another `/`, it is an
 * ordinary character, so `user@host`, `US$5`, `a$b` and `/usr/bin` never open a
 * list. A cursor inside an existing token completes nothing.
 */
export function detectMentionTrigger(
  text: string,
  cursor: number,
  enabled: ReadonlySet<MentionTrigger>,
  tokens: readonly Pick<ComposerToken, "start" | "end">[] = [],
): MentionTriggerMatch | null {
  if (cursor < 1 || cursor > text.length) return null;
  if (tokens.some((token) => cursor > token.start && cursor <= token.end)) return null;
  let start = cursor;
  while (start > 0 && !/\s/u.test(text[start - 1] ?? "")) {
    start -= 1;
    if (cursor - start > MENTION_TOKEN_LIMITS.queryCharacters + 2) return null;
  }
  // One opening bracket or quote may precede the trigger: `($gmail`, `"$gmail`.
  if (OPENERS.has(text[start] ?? "") && start + 1 < cursor) start += 1;
  const trigger = text[start] ?? "";
  if (!isEnabledTrigger(trigger, enabled)) return null;
  if (tokens.some((token) => start >= token.start && start < token.end)) return null;
  const query = text.slice(start + 1, cursor);
  if (!QUERY.test(query)) return null;
  if (trigger === "$" && isShellLikeDollarQuery(query)) return null;
  return { trigger, start, end: cursor, query };
}

function isEnabledTrigger(
  char: string,
  enabled: ReadonlySet<MentionTrigger>,
): char is MentionTrigger {
  return (
    (MENTION_TRIGGERS as readonly string[]).includes(char) && enabled.has(char as MentionTrigger)
  );
}

/** Replace a trigger match with a label and one space; the pure form of a pick. */
export function insertTokenText(
  text: string,
  match: Pick<MentionTriggerMatch, "start" | "end">,
  label: string,
): {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly cursor: number;
} {
  const after = text.slice(match.end);
  const spacer = after.startsWith(" ") ? "" : " ";
  const next = text.slice(0, match.start) + label + spacer + after;
  return {
    text: next,
    start: match.start,
    end: match.start + label.length,
    cursor: match.start + label.length + 1,
  };
}

export type TokenRange = { readonly start: number; readonly end: number };

export type TokenReconciliation = {
  readonly tokens: readonly ComposerToken[];
  /** Tokens whose text was edited: they are plain text now, and the user is told. */
  readonly demoted: readonly ComposerToken[];
};

/**
 * Carry tokens across a text change.
 *
 * With `ranges`, the editor has reported where each token now sits: a token with no
 * range was deleted, and one whose range no longer holds its label was edited and
 * becomes plain text. Without ranges, a token survives only where its label still
 * reads at its recorded place.
 */
export function reconcileTokens(
  tokens: readonly ComposerToken[],
  text: string,
  ranges?: ReadonlyMap<string, TokenRange>,
): TokenReconciliation {
  const kept: ComposerToken[] = [];
  const demoted: ComposerToken[] = [];
  for (const token of tokens) {
    const range = ranges === undefined ? token : ranges.get(token.id);
    if (range === undefined) continue;
    if (text.slice(range.start, range.end) === token.label) {
      kept.push(
        range.start === token.start && range.end === token.end
          ? token
          : { ...token, start: range.start, end: range.end },
      );
    } else {
      demoted.push(token);
    }
  }
  kept.sort((a, b) => a.start - b.start);
  return { tokens: kept, demoted };
}

/** Whether the tokens still read exactly where they claim to be. */
export function tokensMatchText(tokens: readonly ComposerToken[], text: string): boolean {
  return tokens.every((token) => text.slice(token.start, token.end) === token.label);
}

const PLACEHOLDER = /\u27E6(\d{1,3})\u27E7/gu;

function placeholder(index: number): string {
  return `\u27E6${index}\u27E7`;
}

/**
 * The draft with each token replaced by an opaque placeholder, for any transform
 * that rewrites text (prompt enhancement). Placeholders carry no identity.
 */
export function withTokenPlaceholders(text: string, tokens: readonly ComposerToken[]): string {
  let out = "";
  let at = 0;
  tokens.forEach((token, index) => {
    out += text.slice(at, token.start) + placeholder(index + 1);
    at = token.end;
  });
  return out + text.slice(at);
}

export type PlaceholderRestore =
  | { readonly ok: true; readonly text: string; readonly tokens: readonly ComposerToken[] }
  | { readonly ok: false; readonly reason: "token-mismatch" };

/**
 * Rebind tokens into rewritten text. Every placeholder must appear exactly once and
 * no other may: a transform cannot drop, duplicate or invent a pick.
 */
export function restoreTokenPlaceholders(
  proposal: string,
  tokens: readonly ComposerToken[],
): PlaceholderRestore {
  const seen = new Set<number>();
  for (const match of proposal.matchAll(PLACEHOLDER)) {
    const index = Number(match[1]);
    if (index < 1 || index > tokens.length || seen.has(index)) {
      return { ok: false, reason: "token-mismatch" };
    }
    seen.add(index);
  }
  if (seen.size !== tokens.length) return { ok: false, reason: "token-mismatch" };
  let text = "";
  let at = 0;
  const rebound: ComposerToken[] = [];
  for (const match of proposal.matchAll(PLACEHOLDER)) {
    const token = tokens[Number(match[1]) - 1] as ComposerToken;
    text += proposal.slice(at, match.index);
    rebound.push({ ...token, start: text.length, end: text.length + token.label.length });
    text += token.label;
    at = (match.index ?? 0) + match[0].length;
  }
  text += proposal.slice(at);
  return { ok: true, text, tokens: rebound.sort((a, b) => a.start - b.start) };
}

/** Why one more token of this kind cannot join the draft, or null when it can. */
export function tokenLimitReason(
  tokens: readonly Pick<ComposerToken, "trigger" | "kind">[],
  next: Pick<ComposerToken, "trigger" | "kind">,
): string | null {
  if (tokens.length >= MENTION_TOKEN_LIMITS.draft) {
    return `A draft holds at most ${MENTION_TOKEN_LIMITS.draft} mentions.`;
  }
  if (next.trigger === "$") {
    const capabilities = tokens.filter((token) => token.trigger === "$");
    if (capabilities.length >= MENTION_TOKEN_LIMITS.capabilities) {
      return `At most ${MENTION_TOKEN_LIMITS.capabilities} capabilities per prompt.`;
    }
    if (
      next.kind === "skill" &&
      capabilities.filter((token) => token.kind === "skill").length >= MENTION_TOKEN_LIMITS.skills
    ) {
      return `At most ${MENTION_TOKEN_LIMITS.skills} skills per prompt.`;
    }
  }
  return null;
}

const KIND_WORDS: Readonly<Record<MentionTokenKind, string>> = {
  skill: "skill",
  package: "package",
  "mcp-server": "MCP server",
  template: "template",
  file: "file",
  directory: "folder",
  symbol: "symbol",
  resource: "resource",
};

/** The one-line transcript receipt for a prompt's capability tokens, or null. */
export function describeMentionReceipt(
  tokens: readonly Pick<ComposerToken, "trigger" | "kind" | "label" | "source">[],
): string | null {
  const used = tokens.filter((token) => token.trigger === "$");
  if (used.length === 0) return null;
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const token of used) {
    const key = `${token.kind}:${token.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(
      `${token.label.slice(1)} (${KIND_WORDS[token.kind]}${token.source ? `, ${token.source}` : ""})`,
    );
  }
  return `Using: ${parts.join(" · ")}`;
}
