/**
 * Skill validity findings (#1124). One deterministic answer to "why can't this skill
 * load or work?": which skill, from which source, what is wrong and how to fix it.
 * Findings are derived from facts discovery already published, plus bounded link
 * checks; they never judge quality (rare use, size or style are not failures), never
 * carry a skill body, configuration value or secret, and never change anything.
 */
import { z } from "zod";
import type { SkillCatalogEntry } from "./skill-invocation.ts";

export const SKILL_FINDINGS_VERSION = 1;
export const SKILL_FINDING_CODES = [
  "metadata-invalid",
  "version-incompatible",
  "reference-missing",
  "capability-unavailable",
  "name-conflict",
  "shadowed",
  "activation-failed",
  "restricted",
] as const;
export type SkillFindingCode = (typeof SKILL_FINDING_CODES)[number];
export const SKILL_FINDING_SEVERITIES = ["error", "warning", "info"] as const;
export type SkillFindingSeverity = (typeof SKILL_FINDING_SEVERITIES)[number];

/** Each code has one severity, so a count by severity means the same thing everywhere. */
export const SKILL_FINDING_SEVERITY: Readonly<Record<SkillFindingCode, SkillFindingSeverity>> =
  Object.freeze({
    "metadata-invalid": "error",
    "version-incompatible": "error",
    "reference-missing": "warning",
    "capability-unavailable": "warning",
    "name-conflict": "warning",
    shadowed: "info",
    "activation-failed": "error",
    restricted: "info",
  });

export const SKILL_FINDING_LIMITS = Object.freeze({
  /** Findings `falryn doctor` names; the rest are counted and listed by the catalog. */
  doctorTop: 20,
  /** One catalog page: entries, and encoded bytes. */
  page: 100,
  pageBytes: 262_144,
  /** Relative links one SKILL.md contributes to reference checks. */
  links: 64,
  /** MCP servers one `allowed-tools` hint names. */
  servers: 16,
  /** Recorded refusal reasons kept per skill. */
  refusalReasons: 8,
});

/**
 * Facts discovery recorded while it held one SKILL.md's bytes, bound to their digest so
 * they can never describe other content. No body text is kept.
 */
export type SkillScanFacts = {
  readonly digest: string;
  readonly bytes: number;
  /** The frontmatter field at fault, or null. */
  readonly field: string | null;
  /** Relative links in the entrypoint, outside fenced code. */
  readonly links: readonly string[];
  /** MCP servers `allowed-tools` names as `mcp__<server>__<tool>`. */
  readonly mcpServers: readonly string[];
};

/** Why a link resolved the way it did; only `present` is healthy. */
export const SKILL_REFERENCE_STATES = [
  "present",
  "missing",
  "escaped",
  "hidden",
  "symlink",
  "not-a-file",
  "unreadable",
] as const;
export type SkillReferenceState = (typeof SKILL_REFERENCE_STATES)[number];

export type SkillFindingSkill = {
  readonly name: string;
  /** The instruction source key. */
  readonly source: string;
  readonly origin: string;
  /** The entrypoint relative to its root; never an absolute path. */
  readonly path: string;
  readonly scope: string;
  /** The SKILL.md content digest, or null when it was not read. */
  readonly digest: string | null;
};

export type SkillFinding = {
  readonly code: SkillFindingCode;
  readonly severity: SkillFindingSeverity;
  readonly skill: SkillFindingSkill;
  readonly message: string;
  /** Names, codes, counts and relative paths only. */
  readonly evidence: Readonly<Record<string, string | number>>;
  readonly fix: string;
};

export type SkillFindingEntry = SkillFindingSkill & {
  /** How name resolution treats this source now. */
  readonly state: SkillCatalogEntry["state"];
  /** SKILL.md size as a fact, never a finding; null when it was not read. */
  readonly bytes: number | null;
  readonly findings: readonly SkillFinding[];
};

/** The published facts about one catalog entry that derivation reads. */
export type SkillFindingInput = {
  readonly entry: SkillCatalogEntry & { readonly digest: string | null };
  readonly trusted: boolean;
  /** Workspace trust as it stands, for an untrusted project skill; null when unknown. */
  readonly trust?: { readonly status: string; readonly reason: string } | null;
  readonly problem: string | null;
  /** Declared eligibility; null when the entrypoint could not be read or parsed. */
  readonly eligibility: { readonly user: boolean; readonly automatic: boolean } | null;
  /** A preference restriction on this source, if any. */
  readonly restriction: { readonly user: boolean; readonly automatic: boolean } | null;
  /** The source that wins this name, when this one is shadowed. */
  readonly winner: Pick<SkillFindingSkill, "source" | "origin" | "path"> | null;
  /** Equal-priority sources of the same name, when this one conflicts. */
  readonly rivals: number;
  readonly facts: SkillScanFacts | null;
  readonly references: readonly {
    readonly path: string;
    readonly state: SkillReferenceState;
  }[];
  /** Configured MCP server IDs; null when configuration could not be read. */
  readonly mcpServers: ReadonlySet<string> | null;
  /** Refusals recorded for this exact source and content, by reason. */
  readonly refusals: Readonly<Record<string, number>>;
};

const METADATA_PROBLEMS = new Set([
  "unsupported-casing",
  "malformed-utf8",
  "malformed-metadata",
  "name-mismatch",
  "malformed-eligibility",
]);
const LOAD_PROBLEMS = new Set(["symlink", "not-a-file", "oversized", "unreadable"]);

function metadataFix(problem: string, field: string | null, bundle: string): string {
  switch (problem) {
    case "unsupported-casing":
      return "Rename the entrypoint to exactly SKILL.md.";
    case "malformed-utf8":
      return "Save SKILL.md as UTF-8 text.";
    case "name-mismatch":
      return `Set name to "${bundle}", the skill directory's name, or rename the directory.`;
    case "malformed-eligibility":
      return `Set ${field ?? "the invocation control"} to true or false.`;
    default:
      return field === null
        ? "Start SKILL.md with a --- frontmatter block that holds name and description."
        : `Give the frontmatter a valid ${field}: name is lowercase words joined by single hyphens (at most 64 characters) and description is 1 to 1,024 characters.`;
  }
}

function loadFix(reason: string, trust?: { readonly reason: string } | null): string {
  switch (reason) {
    case "workspace-untrusted":
      return trust?.reason === "inventory-malformed"
        ? "Workspace trust review failed because a project file is malformed (a SKILL.md needs name and description frontmatter). Check a skill directory with falryn extension inspect <directory>, fix it, then open Falryn interactively to review the workspace."
        : "Open Falryn interactively in this workspace and review the project skills to trust them.";
    case "oversized":
      return "Keep SKILL.md under 1 MiB; move detail into files the skill links to.";
    case "symlink":
    case "not-a-file":
      return "Make SKILL.md a regular file inside the skill directory; symlinks are never followed.";
    case "unreadable":
      return "Make SKILL.md readable by the current user.";
    default:
      return "Fix the reason shown, then start a new turn; the next admission checks the skill again.";
  }
}

/** Every finding for one catalog entry, in catalog order of codes. */
export function deriveSkillFindings(input: SkillFindingInput): SkillFindingEntry {
  const { entry } = input;
  const skill: SkillFindingSkill = {
    name: entry.name,
    source: entry.source,
    origin: entry.origin,
    path: entry.path,
    scope: entry.scope,
    digest: entry.digest,
  };
  const facts = input.facts !== null && input.facts.digest === entry.digest ? input.facts : null;
  const findings: SkillFinding[] = [];
  const add = (
    code: SkillFindingCode,
    message: string,
    evidence: Record<string, string | number>,
    fix: string,
  ) =>
    findings.push({ code, severity: SKILL_FINDING_SEVERITY[code], skill, message, evidence, fix });
  const bundle = entry.path.split("/").at(-2) ?? entry.name;

  if (input.problem !== null && METADATA_PROBLEMS.has(input.problem))
    add(
      "metadata-invalid",
      `${entry.path} cannot be used: ${input.problem}${facts?.field ? ` (${facts.field})` : ""}.`,
      { problem: input.problem, ...(facts?.field ? { field: facts.field } : {}) },
      metadataFix(input.problem, facts?.field ?? null, bundle),
    );
  if (input.problem === "unsupported-control")
    add(
      "version-incompatible",
      `${entry.path} declares ${facts?.field ?? "an execution control"}, which this Falryn version does not honor, so the skill is unavailable.`,
      { problem: input.problem, ...(facts?.field ? { field: facts.field } : {}) },
      `Remove ${facts?.field ?? "the unsupported control"} from the frontmatter, or wait for a Falryn version that honors it.`,
    );
  for (const reference of input.references)
    if (reference.state !== "present")
      add(
        "reference-missing",
        `${entry.path} links to ${reference.path}, which is ${reference.state}.`,
        { path: reference.path, state: reference.state },
        reference.state === "missing"
          ? `Add ${reference.path} to the skill directory or correct the link.`
          : "Link only to regular, non-hidden files inside the skill directory.",
      );
  if (input.mcpServers !== null && facts !== null)
    for (const server of facts.mcpServers)
      if (!input.mcpServers.has(server))
        add(
          "capability-unavailable",
          `allowed-tools names MCP server ${server}, which is not configured.`,
          { server, field: "allowed-tools" },
          `Configure MCP server "${server}" in tools.mcpConnections, or remove it from allowed-tools. allowed-tools is a hint and grants nothing.`,
        );
  if (entry.state === "conflicting")
    add(
      "name-conflict",
      `${input.rivals + 1} equal-priority skills are named ${entry.name}; neither loads automatically until one is chosen.`,
      { reason: entry.reason, sources: input.rivals + 1 },
      "Choose one source in instructions.preferences, or rename one of the skills.",
    );
  if (entry.state === "shadowed" && input.winner !== null)
    add(
      "shadowed",
      `A higher-priority ${input.winner.origin} skill at ${input.winner.path} has the same name, so this copy never loads.`,
      {
        winner: input.winner.source,
        winnerOrigin: input.winner.origin,
        winnerPath: input.winner.path,
      },
      "Rename this skill, or remove the higher-priority copy, to use it.",
    );
  const load = !input.trusted
    ? "workspace-untrusted"
    : input.problem !== null && LOAD_PROBLEMS.has(input.problem)
      ? input.problem
      : null;
  if (load !== null)
    add(
      "activation-failed",
      `${entry.path} cannot be loaded: ${load}.`,
      {
        reason: load,
        ...(load === "workspace-untrusted" && input.trust
          ? { trustStatus: input.trust.status, trustReason: input.trust.reason }
          : {}),
      },
      loadFix(load, load === "workspace-untrusted" ? input.trust : null),
    );
  for (const [reason, count] of Object.entries(input.refusals).slice(
    0,
    SKILL_FINDING_LIMITS.refusalReasons,
  ))
    add(
      "activation-failed",
      `A recorded admission refused this exact content ${count} time${count === 1 ? "" : "s"}: ${reason}.`,
      { reason, count, recorded: "admission" },
      loadFix(reason),
    );
  if (input.eligibility?.automatic === false)
    add(
      "restricted",
      "disable-model-invocation: true keeps this skill out of automatic selection.",
      { field: "disable-model-invocation" },
      `Invoke it with /skill:${entry.name}, or remove disable-model-invocation to allow automatic use.`,
    );
  else if (input.restriction?.automatic === false)
    add(
      "restricted",
      "A restriction in instructions.preferences keeps this skill out of automatic selection.",
      { field: "instructions.preferences" },
      "Change the restriction in instructions.preferences to allow automatic use.",
    );
  return {
    ...skill,
    state: entry.state,
    bytes: facts?.bytes ?? null,
    findings,
  };
}

/** A catalog query's skill-findings filter. Unknown fields fail closed. */
export const skillFindingsQuerySchema = z.strictObject({
  code: z.enum(SKILL_FINDING_CODES).optional(),
  severity: z.enum(SKILL_FINDING_SEVERITIES).optional(),
  /** Exact skill name. */
  name: z.string().min(1).max(64).optional(),
  /** Only skills that have at least one finding after filtering. */
  findingsOnly: z.boolean().default(false),
  offset: z.int().min(0).max(1_000_000).default(0),
});
export type SkillFindingsQuery = z.input<typeof skillFindingsQuerySchema>;

export type SkillFindingCounts = Readonly<Record<SkillFindingSeverity, number>>;

/** Findings for one discovery generation; `complete` is false when anything was omitted. */
export type SkillFindingsReport =
  | { readonly status: "unavailable"; readonly code: string }
  | {
      readonly status: "inspected";
      readonly version: typeof SKILL_FINDINGS_VERSION;
      readonly generation: string;
      readonly complete: boolean;
      /** Why the result is incomplete: unchecked links, unread history, a cancelled check. */
      readonly omissions: readonly string[];
      /** Every finding in the generation, before filtering. */
      readonly counts: SkillFindingCounts;
      readonly skills: number;
      readonly entries: readonly SkillFindingEntry[];
      /** Entries matching the filter. */
      readonly total: number;
      readonly nextOffset: number | null;
    };

export function countFindings(entries: readonly SkillFindingEntry[]): SkillFindingCounts {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const entry of entries) for (const finding of entry.findings) counts[finding.severity]++;
  return counts;
}

/** One page of findings, at most 100 entries or 256 KiB of encoded JSON. */
export function pageSkillFindings(
  base: {
    readonly generation: string;
    readonly complete: boolean;
    readonly omissions: readonly string[];
  },
  entries: readonly SkillFindingEntry[],
  query: z.output<typeof skillFindingsQuerySchema>,
): Extract<SkillFindingsReport, { status: "inspected" }> {
  const filtered = entries
    .filter((entry) => query.name === undefined || entry.name === query.name)
    .map((entry) => ({
      ...entry,
      findings: entry.findings.filter(
        (finding) =>
          (query.code === undefined || finding.code === query.code) &&
          (query.severity === undefined || finding.severity === query.severity),
      ),
    }))
    .filter(
      (entry) =>
        entry.findings.length > 0 ||
        (!query.findingsOnly && query.code === undefined && query.severity === undefined),
    );
  const page: SkillFindingEntry[] = [];
  let bytes = 0;
  for (const entry of filtered.slice(query.offset)) {
    const size = new TextEncoder().encode(JSON.stringify(entry)).byteLength;
    if (page.length >= SKILL_FINDING_LIMITS.page) break;
    if (page.length > 0 && bytes + size > SKILL_FINDING_LIMITS.pageBytes) break;
    page.push(entry);
    bytes += size;
  }
  const next = query.offset + page.length;
  return {
    status: "inspected",
    version: SKILL_FINDINGS_VERSION,
    generation: base.generation,
    complete: base.complete,
    omissions: base.omissions,
    counts: countFindings(entries),
    skills: entries.length,
    entries: page,
    total: filtered.length,
    nextOffset: next < filtered.length ? next : null,
  };
}

const SEVERITY_ORDER: Readonly<Record<SkillFindingSeverity, number>> = {
  error: 0,
  warning: 1,
  info: 2,
};

/** The most severe findings first, then by skill name, code and path. */
export function topFindings(
  entries: readonly SkillFindingEntry[],
  limit: number = SKILL_FINDING_LIMITS.doctorTop,
): { readonly findings: readonly SkillFinding[]; readonly omitted: number } {
  const all = entries
    .flatMap((entry) => entry.findings)
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        (a.skill.name < b.skill.name ? -1 : a.skill.name > b.skill.name ? 1 : 0) ||
        (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) ||
        (a.skill.path < b.skill.path ? -1 : a.skill.path > b.skill.path ? 1 : 0),
    );
  return { findings: all.slice(0, limit), omitted: Math.max(0, all.length - limit) };
}

/** One finding in words, shared by doctor, the catalog and `/skills`. */
export function skillFindingLine(finding: SkillFinding): string {
  return `${finding.severity} ${finding.code} · ${finding.skill.name} (${finding.skill.origin} ${finding.skill.path}): ${finding.message} Fix: ${finding.fix}`;
}

/** Human lines for a findings page; the same projection every surface prints. */
export function skillFindingsLines(report: SkillFindingsReport): string[] {
  if (report.status === "unavailable") return [`Skill findings: unavailable (${report.code}).`];
  const lines = [
    `Skill findings for discovery generation ${report.generation.slice(0, 19)}: ${report.counts.error} error, ${report.counts.warning} warning, ${report.counts.info} info across ${report.skills} skills.`,
  ];
  if (!report.complete) lines.push(`Incomplete: ${report.omissions.join(", ")}.`);
  for (const entry of report.entries) {
    lines.push(
      `${entry.name} — ${entry.state} — ${entry.origin} ${entry.path}${entry.bytes === null ? "" : ` — ${entry.bytes} bytes`}`,
    );
    for (const finding of entry.findings) lines.push(`  ${skillFindingLine(finding)}`);
  }
  if (report.nextOffset !== null) lines.push(`More: request offset ${report.nextOffset}.`);
  return lines;
}

/**
 * The findings block `/skills` appends: counts, the listed skills' most severe findings,
 * and a stale notice when the generation changed since this session last showed them.
 */
export function skillFindingsNoticeLines(
  collected:
    | { readonly status: "unavailable"; readonly code: string }
    | {
        readonly status: "collected";
        readonly generation: string;
        readonly complete: boolean;
        readonly omissions: readonly string[];
        readonly entries: readonly SkillFindingEntry[];
      },
  filter: string | null,
  previousGeneration: string | null,
): string[] {
  if (collected.status === "unavailable")
    return [`Skill findings: unavailable (${collected.code}).`];
  const lines: string[] = [];
  if (previousGeneration !== null && previousGeneration !== collected.generation)
    lines.push(
      `Findings shown earlier for discovery generation ${previousGeneration.slice(7, 19)} are stale; these are for ${collected.generation.slice(7, 19)}.`,
    );
  const counts = countFindings(collected.entries);
  lines.push(
    `Findings (generation ${collected.generation.slice(7, 19)}): ${counts.error} error, ${counts.warning} warning, ${counts.info} info${collected.complete ? "" : `; incomplete (${collected.omissions.join(", ")})`}.`,
  );
  const listed = collected.entries.filter(
    (entry) => filter === null || entry.name.includes(filter.toLowerCase()),
  );
  const top = topFindings(listed);
  for (const finding of top.findings) lines.push(`  ${skillFindingLine(finding)}`);
  if (top.omitted > 0)
    lines.push(`  ${top.omitted} more; list them all with falryn extension catalog.`);
  return lines;
}
