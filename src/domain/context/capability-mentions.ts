/**
 * `$` capability mentions (#1206): what the composer can offer, how it ranks, and
 * how picked tokens are admitted into one turn.
 *
 * A candidate is a snapshot of a skill, an activated package or a configured MCP
 * server, with the identity a pick binds to. Listing never reads a skill body, a
 * tool schema or a prompt, and never starts a server. Admission compares each
 * picked identity with the current candidates; it grants nothing a candidate did
 * not already have.
 */

import {
  type ComposerToken,
  type ComposerTokenPick,
  MENTION_TOKEN_LIMITS,
} from "./composer-mentions.ts";

export const CAPABILITY_MENTION_KINDS = ["skill", "package", "mcp-server"] as const;
export type CapabilityMentionKind = (typeof CAPABILITY_MENTION_KINDS)[number];

export type CapabilityMentionAvailability =
  | { readonly kind: "available" }
  | { readonly kind: "unavailable"; readonly reason: string; readonly repair: string | null };

export type CapabilityMentionCandidate = {
  readonly kind: CapabilityMentionKind;
  /** Skill name, package id or MCP server id. */
  readonly name: string;
  /** The exact identity a pick binds; a change makes the pick stale. */
  readonly identity: string;
  readonly generation: string;
  /** Scope, origin or version, shown beside the label. */
  readonly source: string;
  readonly availability: CapabilityMentionAvailability;
  /** Executable capability IDs a pick prefers for the turn (packages and servers). */
  readonly capabilityIds: readonly string[];
  /** MCP servers only: whether the catalog must be connected or refreshed first. */
  readonly catalog?: "current" | "stale" | "unknown";
};

export type CapabilityMentionRow = {
  readonly candidate: CapabilityMentionCandidate;
  /** The label a pick inserts, trigger included. */
  readonly label: string;
  readonly match: "exact" | "prefix" | "fuzzy";
};

export type CapabilityMentionPage = {
  readonly rows: readonly CapabilityMentionRow[];
  readonly total: number;
};

const KIND_ORDER: Readonly<Record<CapabilityMentionKind, number>> = {
  skill: 0,
  package: 1,
  "mcp-server": 2,
};

const KIND_PREFIX: Readonly<Record<string, CapabilityMentionKind>> = {
  skill: "skill",
  package: "package",
  mcp: "mcp-server",
};

/** The page size a query returns; the list shows fewer. */
export const CAPABILITY_MENTION_PAGE = 50;

function shortLabel(candidate: CapabilityMentionCandidate): string {
  return candidate.kind === "mcp-server" ? `mcp:${candidate.name}` : candidate.name;
}

/**
 * The label each candidate inserts. A name shared by candidates of different kinds
 * is kind-qualified (`$skill:x`, `$package:x`) so the draft stays unambiguous.
 */
export function capabilityMentionLabels(
  candidates: readonly CapabilityMentionCandidate[],
): ReadonlyMap<CapabilityMentionCandidate, string> {
  const kindsByName = new Map<string, Set<CapabilityMentionKind>>();
  for (const candidate of candidates) {
    const name = shortLabel(candidate);
    const kinds = kindsByName.get(name) ?? new Set();
    kinds.add(candidate.kind);
    kindsByName.set(name, kinds);
  }
  const labels = new Map<CapabilityMentionCandidate, string>();
  for (const candidate of candidates) {
    const name = shortLabel(candidate);
    const shared = (kindsByName.get(name)?.size ?? 0) > 1;
    labels.set(
      candidate,
      shared && candidate.kind !== "mcp-server" ? `$${candidate.kind}:${name}` : `$${name}`,
    );
  }
  return labels;
}

function isSubsequence(needle: string, haystack: string): boolean {
  let at = 0;
  for (const char of haystack) {
    if (char === needle[at]) at += 1;
    if (at === needle.length) return true;
  }
  return needle.length === 0;
}

/**
 * Rank candidates for a `$` query. A leading `skill:`, `package:` or `mcp:` filters by
 * kind. Exact matches come before prefix matches, then fuzzy ones; ties order by
 * kind (skill, package, MCP server) and then label.
 */
export function rankCapabilityMentions(
  query: string,
  candidates: readonly CapabilityMentionCandidate[],
  limit = CAPABILITY_MENTION_PAGE,
): CapabilityMentionPage {
  const lowered = query.toLowerCase();
  const colon = lowered.indexOf(":");
  const filterKind = colon > 0 ? KIND_PREFIX[lowered.slice(0, colon)] : undefined;
  const needle = filterKind === undefined ? lowered : lowered.slice(colon + 1);
  const labels = capabilityMentionLabels(candidates);
  const rows: (CapabilityMentionRow & { readonly rank: number })[] = [];
  for (const candidate of candidates) {
    if (filterKind !== undefined && candidate.kind !== filterKind) continue;
    const label = labels.get(candidate) ?? `$${candidate.name}`;
    const name = candidate.name.toLowerCase();
    const bare = label.slice(1).toLowerCase();
    const match =
      needle === name || lowered === bare
        ? "exact"
        : name.startsWith(needle) || bare.startsWith(lowered)
          ? "prefix"
          : isSubsequence(needle, name)
            ? "fuzzy"
            : null;
    if (match === null) continue;
    rows.push({
      candidate,
      label,
      match,
      rank: match === "exact" ? 0 : match === "prefix" ? 1 : 2,
    });
  }
  rows.sort(
    (a, b) =>
      a.rank - b.rank ||
      KIND_ORDER[a.candidate.kind] - KIND_ORDER[b.candidate.kind] ||
      (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
  );
  return {
    rows: rows.slice(0, limit).map(({ rank: _rank, ...row }) => row),
    total: rows.length,
  };
}

/**
 * The single available row whose label is exactly what was typed, or null. Typing
 * that label and a space converts it as if picked; anything ambiguous needs a pick.
 */
export function exactCapabilityMention(
  query: string,
  candidates: readonly CapabilityMentionCandidate[],
): CapabilityMentionRow | null {
  const labels = capabilityMentionLabels(candidates);
  const exact = candidates.filter(
    (candidate) =>
      candidate.availability.kind === "available" && labels.get(candidate) === `$${query}`,
  );
  const only = exact[0];
  if (exact.length !== 1 || only === undefined) {
    return null;
  }
  return { candidate: only, label: `$${query}`, match: "exact" };
}

/** The token a row inserts. */
export function capabilityMentionPick(row: CapabilityMentionRow): ComposerTokenPick {
  return {
    trigger: "$",
    kind: row.candidate.kind,
    identity: row.candidate.identity,
    label: row.label,
    source: row.candidate.source,
    generation: row.candidate.generation,
  };
}

export const CAPABILITY_MENTION_REFUSALS = [
  "mention.stale",
  "mention.unavailable",
  "mention.untrusted",
  "mention.not-user-invocable",
  "mention.conflict",
  "mention.limit",
  "mention.connect-failed",
] as const;
export type CapabilityMentionRefusalCode = (typeof CAPABILITY_MENTION_REFUSALS)[number];

export type CapabilityMentionFailure = {
  readonly tokenId: string;
  readonly label: string;
  readonly code: CapabilityMentionRefusalCode;
  readonly reason: string;
  readonly repair: string | null;
};

export type CapabilityMentionAdmission =
  | {
      readonly ok: true;
      /** Skills loaded with user origin, in draft order. */
      readonly skills: readonly string[];
      /** Capability IDs preferred for this turn only. */
      readonly preferredCapabilityIds: readonly string[];
      /** MCP servers the user selected for this turn. */
      readonly mcpServers: readonly string[];
      readonly packages: readonly string[];
      /** Servers whose catalog must be connected or refreshed before the turn. */
      readonly connect: readonly string[];
    }
  | { readonly ok: false; readonly failures: readonly CapabilityMentionFailure[] };

function unavailableCode(reason: string): CapabilityMentionRefusalCode {
  if (/trust/iu.test(reason)) return "mention.untrusted";
  if (/invocable/iu.test(reason)) return "mention.not-user-invocable";
  if (/conflict/iu.test(reason)) return "mention.conflict";
  return "mention.unavailable";
}

/**
 * Admit the `$` tokens of one prompt against the current candidates. One failing
 * token refuses the whole prompt, with one failure per token.
 */
export function admitCapabilityMentions(
  tokens: readonly ComposerToken[],
  current: readonly CapabilityMentionCandidate[],
): CapabilityMentionAdmission {
  const picked = tokens.filter((token) => token.trigger === "$");
  const failures: CapabilityMentionFailure[] = [];
  const skills: string[] = [];
  const preferred = new Set<string>();
  const servers: string[] = [];
  const packages: string[] = [];
  const connect: string[] = [];
  const seen = new Set<string>();
  if (picked.length > MENTION_TOKEN_LIMITS.capabilities) {
    return {
      ok: false,
      failures: picked.slice(MENTION_TOKEN_LIMITS.capabilities).map((token) => ({
        tokenId: token.id,
        label: token.label,
        code: "mention.limit" as const,
        reason: `at most ${MENTION_TOKEN_LIMITS.capabilities} capabilities per prompt`,
        repair: "remove a capability mention",
      })),
    };
  }
  for (const token of picked) {
    const key = `${token.kind}\u0000${token.identity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const candidate = current.find(
      (item) => item.kind === token.kind && item.identity === token.identity,
    );
    if (candidate === undefined) {
      const renamed = current.find(
        (item) => item.kind === token.kind && `$${item.name}` === token.label,
      );
      failures.push({
        tokenId: token.id,
        label: token.label,
        code: "mention.stale",
        reason:
          renamed === undefined
            ? `${token.label} is no longer available`
            : `${token.label} changed since you picked it`,
        repair: "pick it again from the list",
      });
      continue;
    }
    if (candidate.availability.kind === "unavailable") {
      failures.push({
        tokenId: token.id,
        label: token.label,
        code: unavailableCode(candidate.availability.reason),
        reason: `${token.label}: ${candidate.availability.reason}`,
        repair: candidate.availability.repair,
      });
      continue;
    }
    switch (candidate.kind) {
      case "skill":
        skills.push(candidate.name);
        break;
      case "package":
        packages.push(candidate.name);
        for (const id of candidate.capabilityIds) preferred.add(id);
        break;
      case "mcp-server":
        servers.push(candidate.name);
        for (const id of candidate.capabilityIds) preferred.add(id);
        if (candidate.catalog !== "current") connect.push(candidate.name);
        break;
      default: {
        const exhaustive: never = candidate.kind;
        return exhaustive;
      }
    }
  }
  if (skills.length > MENTION_TOKEN_LIMITS.skills) {
    failures.push({
      tokenId: picked.find((token) => token.kind === "skill")?.id ?? "",
      label: "$skill",
      code: "mention.limit",
      reason: `at most ${MENTION_TOKEN_LIMITS.skills} skills per prompt`,
      repair: "remove a skill mention",
    });
  }
  if (failures.length > 0) return { ok: false, failures };
  return {
    ok: true,
    skills,
    preferredCapabilityIds: [...preferred],
    mcpServers: servers,
    packages,
    connect,
  };
}

/** One line per failure for the composer's status, naming the repair. */
export function describeCapabilityMentionFailures(
  failures: readonly CapabilityMentionFailure[],
): string {
  return failures
    .map((failure) =>
      failure.repair === null ? failure.reason : `${failure.reason} (${failure.repair})`,
    )
    .join("; ");
}

/**
 * The bounded prompt section that tells the model what the user selected. It names
 * the picks and grants nothing; tools still pass their normal checks.
 */
export function capabilityMentionSection(
  admission: Extract<CapabilityMentionAdmission, { ok: true }>,
): string | null {
  const lines: string[] = [];
  for (const name of admission.skills) lines.push(`- skill ${name}: loaded for this turn`);
  for (const name of admission.packages) {
    lines.push(`- package ${name}: prefer its tools for this turn`);
  }
  for (const name of admission.mcpServers) {
    lines.push(
      `- MCP server ${name}: prefer it for this turn; use its catalog through the MCP tools`,
    );
  }
  if (lines.length === 0) return null;
  return [
    "The user selected these capabilities for this turn with $ mentions in the prompt:",
    ...lines,
    "Selection is a preference, not permission: every tool call still passes its normal checks and approvals.",
  ].join("\n");
}
