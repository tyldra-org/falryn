/**
 * Skill validity findings (#1124): the one application action doctor, the extension
 * catalog, `/skills` and the Extensions view (#274) share. It reads the latest published
 * discovery generation and its catalog decisions in one synchronous step, so a reload
 * publishing meanwhile cannot mix generations, then checks the entrypoints' links with
 * `stat` only. Nothing is read, rewritten, disabled, installed or sent to a model.
 */
import {
  type InstructionScope,
  instructionSourceKey,
} from "../../domain/context/instruction-sources.ts";
import {
  deriveSkillFindings,
  SKILL_FINDING_LIMITS,
  type SkillFindingEntry,
  type SkillFindingInput,
  type SkillReferenceState,
  type SkillScanFacts,
} from "../../domain/context/skill-findings.ts";
import type { SkillCatalogEntry } from "../../domain/context/skill-invocation.ts";
import {
  resolveSkillResourcePath,
  skillResourceLinks,
} from "../../domain/context/skill-resources.ts";
import { bytesDigest } from "../../domain/extensions/canonical.ts";
import { readSkillEntrypoint } from "../../domain/extensions/skill-metadata.ts";
import type { InstructionSourceOwner } from "../context/instruction-source-owner.ts";
import { markdownMetadata } from "./portable-components.ts";

/** Link checks one collection performs; later links are reported as unchecked. */
export const SKILL_REFERENCE_CHECKS = 4_096;

export type SkillRefusalHistory =
  | {
      readonly ok: true;
      /** Recorded refusal reasons, keyed by source key and content digest. */
      readonly refusals: ReadonlyMap<string, Readonly<Record<string, number>>>;
      readonly complete: boolean;
    }
  | { readonly ok: false; readonly code: string };

export type SkillFindingsPorts = {
  readonly owner: Pick<InstructionSourceOwner, "snapshot" | "skillCatalog" | "prepare">;
  readonly scope: Omit<InstructionScope, "execution">;
  readonly diagnostics: {
    facts(sourceKey: string): SkillScanFacts | null;
    reference(sourceKey: string, link: string, signal: AbortSignal): Promise<SkillReferenceState>;
  };
  /** Configured MCP server IDs; null when configuration could not be read. */
  readonly mcpServers: () => ReadonlySet<string> | null;
  /** Workspace trust status and reason, which explain untrusted project skills. */
  readonly workspaceTrust?: () => { readonly status: string; readonly reason: string } | null;
  /** Admission refusals recorded for exact content; absent when no history is available. */
  readonly refusals?: (signal: AbortSignal) => Promise<SkillRefusalHistory>;
};

export type SkillFindingsCollection =
  | { readonly status: "unavailable"; readonly code: string }
  | {
      readonly status: "collected";
      readonly generation: string;
      readonly complete: boolean;
      readonly omissions: readonly string[];
      readonly entries: readonly SkillFindingEntry[];
    };

export const refusalKey = (source: string, digest: string) => `${source}\n${digest}`;

export function createSkillFindings(ports: SkillFindingsPorts) {
  const scope = (execution: string): InstructionScope => ({ ...ports.scope, execution });

  /** Every catalog entry of the latest publication, read without awaiting anything. */
  function published() {
    const snapshot = ports.owner.snapshot();
    if (snapshot === null) return null;
    const entries: SkillCatalogEntry[] = [];
    for (let offset: number | null = 0; offset !== null; ) {
      const page = ports.owner.skillCatalog(scope("skill-findings"), { offset });
      if (page === null || page.generation !== snapshot.generation) return null;
      entries.push(...page.entries);
      offset = page.nextOffset;
    }
    // A total order, so the same files always list the same way: same-named copies in
    // different roots share a name, origin and relative path and differ only by source.
    const key = (entry: SkillCatalogEntry) => [entry.name, entry.origin, entry.path, entry.source];
    entries.sort((a, b) => {
      const left = key(a),
        right = key(b);
      for (let index = 0; index < left.length; index++) {
        const l = left[index] ?? "",
          r = right[index] ?? "";
        if (l !== r) return l < r ? -1 : 1;
      }
      return 0;
    });
    return { snapshot, entries };
  }

  return {
    /**
     * Publish the current discovery generation, as a turn or `/skills` would. Only a
     * scan reads skill entrypoints; findings themselves read nothing.
     */
    async refresh(signal: AbortSignal): Promise<void> {
      await ports.owner
        .prepare(scope(`skill-findings:${crypto.randomUUID()}`), [], signal, undefined, true)
        .catch(() => undefined);
    },

    async collect(signal: AbortSignal): Promise<SkillFindingsCollection> {
      const current = published();
      if (current === null) return { status: "unavailable", code: "discovery-unavailable" };
      const { snapshot, entries } = current;
      const sources = new Map(
        snapshot.sources
          .filter((source) => source.identity.kind === "skill")
          .map((source) => [instructionSourceKey(source.identity), source] as const),
      );
      const facts = new Map(
        entries.map((entry) => [entry.source, ports.diagnostics.facts(entry.source)] as const),
      );
      const omissions: string[] = [];
      const mcpServers = ports.mcpServers();
      if (mcpServers === null) omissions.push("mcp-configuration-unavailable");

      // Everything above is one generation; the checks below only add evidence to it.
      let checks = 0;
      let unchecked = 0;
      let cancelled = false;
      const references = new Map<string, { path: string; state: SkillReferenceState }[]>();
      for (const entry of entries) {
        const own = facts.get(entry.source);
        const source = sources.get(entry.source);
        if (own === null || own === undefined || own.digest !== source?.digest) continue;
        const checked: { path: string; state: SkillReferenceState }[] = [];
        for (const link of own.links) {
          if (cancelled || signal.aborted) {
            cancelled = true;
            unchecked++;
            continue;
          }
          if (checks >= SKILL_REFERENCE_CHECKS) {
            unchecked++;
            continue;
          }
          checks++;
          try {
            checked.push({
              path: link,
              state: await ports.diagnostics.reference(entry.source, link, signal),
            });
          } catch {
            if (signal.aborted) {
              cancelled = true;
              unchecked++;
            } else checked.push({ path: link, state: "unreadable" });
          }
        }
        references.set(entry.source, checked);
      }
      if (unchecked > 0) omissions.push(`references-unchecked:${unchecked}`);

      let refusals: ReadonlyMap<string, Readonly<Record<string, number>>> = new Map();
      if (ports.refusals !== undefined && !cancelled && !signal.aborted) {
        const history = await ports
          .refusals(signal)
          .catch((): SkillRefusalHistory => ({ ok: false, code: "admission-history-unavailable" }));
        if (!history.ok) omissions.push(history.code);
        else {
          refusals = history.refusals;
          if (!history.complete) omissions.push("admission-history-incomplete");
        }
      }
      if (cancelled || signal.aborted) omissions.push("cancelled");

      const derived = entries.map((entry): SkillFindingEntry => {
        const source = sources.get(entry.source);
        const digest = source?.digest ?? null;
        const input: SkillFindingInput = {
          entry: { ...entry, digest },
          trusted: source?.trusted ?? true,
          trust: ports.workspaceTrust?.() ?? null,
          problem: source?.problem ?? null,
          eligibility: source?.eligibility ?? null,
          restriction:
            source?.eligibility?.automatic === true && entry.automatic === false
              ? { user: entry.userInvocable === true, automatic: false }
              : null,
          winner:
            entry.state !== "shadowed"
              ? null
              : (entries.find((other) => other.name === entry.name && other.state === "selected") ??
                null),
          rivals: entries.filter(
            (other) =>
              other.name === entry.name &&
              other.source !== entry.source &&
              other.state === "conflicting",
          ).length,
          facts: facts.get(entry.source) ?? null,
          references: references.get(entry.source) ?? [],
          mcpServers,
          refusals: digest === null ? {} : (refusals.get(refusalKey(entry.source, digest)) ?? {}),
        };
        return deriveSkillFindings(input);
      });
      return {
        status: "collected",
        generation: snapshot.generation,
        complete: omissions.length === 0,
        omissions,
        entries: derived,
      };
    },
  };
}

export type SkillFindings = ReturnType<typeof createSkillFindings>;

/** What one read SKILL.md says about itself, without keeping any of its text. */
export function skillScanFacts(
  bytes: Uint8Array,
  entry: ReturnType<typeof readSkillEntrypoint>,
  metadata: Readonly<Record<string, unknown>> | null,
): SkillScanFacts {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const hint = metadata?.["allowed-tools"];
  const servers =
    typeof hint === "string"
      ? [
          ...new Set(
            [
              ...hint.matchAll(
                /(?:^|[\s,])mcp__([A-Za-z0-9][A-Za-z0-9_-]{0,63}?)__[A-Za-z0-9_*-]/gu,
              ),
            ].map((match) => match[1] ?? ""),
          ),
        ]
          .filter((server) => server !== "")
          .slice(0, SKILL_FINDING_LIMITS.servers)
      : [];
  return {
    digest: bytesDigest(bytes),
    bytes: bytes.byteLength,
    field: entry.ok ? entry.unsupported : entry.field,
    links: skillResourceLinks(text).slice(0, SKILL_FINDING_LIMITS.links),
    mcpServers: servers,
  };
}

/** A SKILL.md larger than this is never loaded; the same bound discovery applies. */
export const SKILL_ENTRYPOINT_BYTES = 1_048_576;

/**
 * Findings for one skill bundle read by `extension inspect` (#1124): the deep check of a
 * path. Links are checked against the files that inspection already listed; resolution,
 * shadowing and admission history do not apply to a path that is not discovered.
 */
export function inspectSkillBundle(input: {
  readonly bundle: string;
  /** The entrypoint relative to the inspected directory. */
  readonly path: string;
  /** The inspected package or directory identity. */
  readonly source: string;
  readonly origin: "inspected-package" | "inspected-directory";
  /** The entrypoint bytes, or the reason they could not be read. */
  readonly entrypoint:
    | { readonly ok: true; readonly bytes: Uint8Array }
    | { readonly ok: false; readonly problem: "symlink" | "not-a-file" | "unreadable" };
  /** Files beneath the bundle, relative to it; null when they were not listed. */
  readonly files: ReadonlySet<string> | null;
  readonly mcpServers: ReadonlySet<string> | null;
}): SkillFindingEntry {
  let problem: string | null = input.entrypoint.ok ? null : input.entrypoint.problem;
  let facts: SkillScanFacts | null = null;
  let eligibility: { user: boolean; automatic: boolean } | null = null;
  let digest: string | null = null;
  if (input.entrypoint.ok) {
    const bytes = input.entrypoint.bytes;
    digest = bytesDigest(bytes);
    if (bytes.byteLength > SKILL_ENTRYPOINT_BYTES) problem = "oversized";
    else {
      let utf8 = true;
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        utf8 = false;
        problem = "malformed-utf8";
      }
      if (utf8) {
        let metadata: Readonly<Record<string, unknown>> | null = null;
        let entry: ReturnType<typeof readSkillEntrypoint>;
        try {
          metadata = markdownMetadata(bytes, true);
          entry = readSkillEntrypoint(metadata, input.bundle);
        } catch {
          entry = { ok: false, problem: "malformed-metadata", field: null };
        }
        if (!entry.ok) problem = entry.problem;
        else {
          if (entry.unsupported !== null) problem = "unsupported-control";
          eligibility = entry.invocation;
        }
        facts = skillScanFacts(bytes, entry, metadata);
      }
    }
  }
  const references =
    facts === null || input.files === null
      ? []
      : facts.links.map((link) => {
          const resolved = resolveSkillResourcePath("", link);
          if (!resolved.ok) return { path: link, state: resolved.reason };
          const files = input.files ?? new Set<string>();
          const present =
            files.has(resolved.path) ||
            [...files].some((file) => file.startsWith(`${resolved.path}/`));
          return { path: link, state: present ? ("present" as const) : ("missing" as const) };
        });
  return deriveSkillFindings({
    entry: {
      name: input.bundle,
      source: input.source,
      origin: input.origin,
      path: input.path,
      scope: "",
      state: "selected",
      reason: "inspected",
      userInvocable: eligibility?.user ?? null,
      automatic: eligibility?.automatic ?? null,
      command: null,
      digest,
    },
    trusted: true,
    problem,
    eligibility,
    restriction: null,
    winner: null,
    rivals: 0,
    facts,
    references,
    mcpServers: input.mcpServers,
    refusals: {},
  });
}
