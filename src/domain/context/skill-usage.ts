/**
 * Source-bound skill usage and context-cost observations (#1191), derived only from stored
 * `instructions.resolved` receipts. Nothing here reads a skill, a prompt or the file system:
 * a receipt already names each skill source's decision, its routing and the context its
 * admission contributed. Counts are separate observations, never one usage counter.
 */
import type { RuntimeEvent } from "../sessions/index.ts";
import type {
  ContextContribution,
  InstructionSourceReceipt,
  SkillRouteFact,
} from "./instruction-source-receipt.ts";
import { PROMPT_TOKEN_ESTIMATOR } from "./prompt-composition.ts";

export const SKILL_USAGE_LIMITS = Object.freeze({
  rows: 256,
  versionsPerRow: 16,
  reasonsPerRow: 16,
});

/**
 * Each observation a receipt can record. `selected` is the source that won name
 * resolution in scope; `loaded` means its complete body entered the request.
 */
export const SKILL_OBSERVATIONS = [
  "discovered",
  "selected",
  "shadowed",
  "excluded",
  "conflicting",
  "recommended",
  "loaded",
  "refused",
] as const;
export type SkillObservation = (typeof SKILL_OBSERVATIONS)[number];

/** Observations Falryn has no producer for yet; they are reported, never counted as zero. */
export const UNRECORDED_SKILL_OBSERVATIONS = ["invoked", "resource-loaded"] as const;

/**
 * Context contributed by counted admissions. `bytes` sums every known size; `tokens`
 * sums only estimated contributions, and `unestimated` counts those a receipt written
 * before estimates were recorded could not supply.
 */
export type ContributionTotal = {
  readonly count: number;
  readonly bytes: number;
  readonly tokens: number;
  readonly unestimated: number;
};

export type ObservationRef = {
  readonly sessionId: string;
  readonly turnId: string;
  readonly eventId: string;
  readonly sequence: number;
  readonly at: string;
};

export type SkillUsageVersion = {
  readonly digest: string | null;
  readonly generation: string;
  readonly admissions: number;
};

export type SkillUsageRow = {
  readonly name: string;
  /** The instruction source key; null when a route named a skill no receipt source matched. */
  readonly source: string | null;
  readonly origin: string | null;
  /** The entrypoint relative to its root; never an absolute path. */
  readonly path: string | null;
  readonly digest: string | null;
  /** Null when rows were explicitly aggregated across generations; see `versions`. */
  readonly generation: string | null;
  readonly counts: Readonly<Record<SkillObservation, number>>;
  /** Loads of a body an identical earlier admission already carried. */
  readonly reused: number;
  readonly reasons: Readonly<Record<string, number>>;
  /** Admissions that observed this row, by the admission scope that recorded them. */
  readonly scopes: { readonly main: number; readonly child: number; readonly workflow: number };
  readonly body: ContributionTotal;
  readonly listing: ContributionTotal;
  readonly first: ObservationRef;
  readonly last: ObservationRef;
  readonly versions?: readonly SkillUsageVersion[];
  readonly versionsOmitted?: number;
};

export type SkillUsageTotals = {
  readonly rows: readonly SkillUsageRow[];
  /** Observations of skills that would have needed a row past the row limit; not counted. */
  readonly observationsBeyondRowLimit: number;
  /** Receipts counted; each is one admission fact. */
  readonly admissions: number;
  readonly reusedAdmissions: number;
  /** Receipts that listed more sources than they retained. */
  readonly sourcesOmitted: number;
  /** The whole routing section, which also holds text no single route owns. */
  readonly routingSection: ContributionTotal;
  readonly duplicates: number;
  readonly estimator: typeof PROMPT_TOKEN_ESTIMATOR;
};

type MutableTotal = { count: number; bytes: number; tokens: number; unestimated: number };
type MutableRow = {
  name: string;
  source: string | null;
  origin: string | null;
  path: string | null;
  digest: string | null;
  generation: string;
  counts: Record<SkillObservation, number>;
  reused: number;
  reasons: Record<string, number>;
  scopes: { main: number; child: number; workflow: number };
  body: MutableTotal;
  listing: MutableTotal;
  first: ObservationRef;
  last: ObservationRef;
};

const emptyTotal = (): MutableTotal => ({ count: 0, bytes: 0, tokens: 0, unestimated: 0 });

function addContribution(
  total: MutableTotal,
  bytes: number | null,
  estimate: ContextContribution | { readonly tokens: number | null } | undefined,
) {
  total.count++;
  total.bytes += bytes ?? 0;
  const tokens = estimate?.tokens;
  if (typeof tokens === "number") total.tokens += tokens;
  else total.unestimated++;
}

type SkillSourceDecision = InstructionSourceReceipt["sources"][number];

/**
 * Fold receipts into rows. Each producing event is counted once, however many pages or
 * projections deliver it; a second delivery is reported as a duplicate.
 */
export function createSkillUsageFold(options: {
  readonly skill?: string | undefined;
  readonly aggregate?: "generation" | "source" | undefined;
}) {
  const rows = new Map<string, MutableRow>();
  const seen = new Set<string>();
  let observationsBeyondRowLimit = 0;
  let admissions = 0;
  let reusedAdmissions = 0;
  let sourcesOmitted = 0;
  let duplicates = 0;
  const section = emptyTotal();

  const row = (
    ref: ObservationRef,
    generation: string,
    identity: {
      readonly name: string;
      readonly source: string | null;
      readonly origin: string | null;
      readonly path: string | null;
      readonly digest: string | null;
    },
  ): MutableRow | null => {
    const key = JSON.stringify([identity.source ?? identity.name, identity.digest, generation]);
    let current = rows.get(key);
    if (current === undefined) {
      if (rows.size >= SKILL_USAGE_LIMITS.rows) {
        observationsBeyondRowLimit++;
        return null;
      }
      current = {
        ...identity,
        generation,
        counts: Object.fromEntries(SKILL_OBSERVATIONS.map((kind) => [kind, 0])) as Record<
          SkillObservation,
          number
        >,
        reused: 0,
        reasons: {},
        scopes: { main: 0, child: 0, workflow: 0 },
        body: emptyTotal(),
        listing: emptyTotal(),
        first: ref,
        last: ref,
      };
      rows.set(key, current);
    }
    current.last = ref;
    return current;
  };

  return {
    /** Count one stored event; anything but an admission receipt is ignored. */
    add(event: RuntimeEvent): "counted" | "ignored" | "duplicate" {
      if (event.kind !== "instructions.resolved") return "ignored";
      const id = String(event.eventId);
      if (seen.has(id)) {
        duplicates++;
        return "duplicate";
      }
      seen.add(id);
      const receipt = event.payload;
      const ref: ObservationRef = {
        sessionId: String(event.correlation.sessionId),
        turnId: String(event.correlation.turnId),
        eventId: id,
        sequence: Number(event.sequence),
        at: String(event.occurredAt),
      };
      const scope = receipt.scope.kind;
      const wanted = (name: string) => options.skill === undefined || options.skill === name;
      admissions++;
      if (receipt.reused) reusedAdmissions++;
      if (receipt.omitted > 0) sourcesOmitted++;
      const observed = new Set<MutableRow>();
      const skills: SkillSourceDecision[] = receipt.sources.filter(
        (decision) => decision.kind === "skill",
      );
      const identityOf = (decision: SkillSourceDecision) => ({
        name: decision.name,
        source: decision.source,
        origin: decision.origin,
        path: decision.identity.path,
        digest: decision.digest,
      });
      for (const decision of skills) {
        if (!wanted(decision.name)) continue;
        const target = row(ref, receipt.generation, identityOf(decision));
        if (target === null) continue;
        observed.add(target);
        target.counts.discovered++;
        target.counts[decision.state]++;
      }
      const routing = receipt.skills;
      if (routing !== undefined) {
        if (routing.section !== undefined && routing.section !== null)
          addContribution(section, routing.section.bytes, routing.section);
        else if (routing.section === undefined && routing.routes.length > 0)
          addContribution(section, null, undefined);
        for (const route of routing.routes) {
          if (!wanted(route.name)) continue;
          const target = routeRow(route, skills, identityOf, (identity) =>
            row(ref, receipt.generation, identity),
          );
          if (target === null) continue;
          observed.add(target);
          const kind: SkillObservation =
            route.decision === "unavailable" ? "refused" : route.decision;
          target.counts[kind]++;
          const reason = `${kind}:${route.reason}`;
          if (
            target.reasons[reason] !== undefined ||
            Object.keys(target.reasons).length < SKILL_USAGE_LIMITS.reasonsPerRow
          )
            target.reasons[reason] = (target.reasons[reason] ?? 0) + 1;
          if (route.decision === "loaded") {
            addContribution(target.body, route.bytes, {
              tokens: route.tokens === undefined ? null : route.tokens,
            });
            if (receipt.reused) target.reused++;
          }
          if (route.listing !== undefined)
            addContribution(target.listing, route.listing.bytes, route.listing);
          else if (routing.estimator === undefined)
            addContribution(target.listing, null, undefined);
        }
      }
      for (const target of observed) target.scopes[scope]++;
      return "counted";
    },
    totals(): SkillUsageTotals {
      const listed = [...rows.values()].sort(
        (a, b) =>
          (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
          (a.origin ?? "").localeCompare(b.origin ?? "") ||
          a.first.at.localeCompare(b.first.at) ||
          a.first.sequence - b.first.sequence,
      );
      const finished =
        options.aggregate === "source" ? aggregateBySource(listed) : listed.map(freezeRow);
      return {
        rows: finished,
        observationsBeyondRowLimit,
        admissions,
        reusedAdmissions,
        sourcesOmitted,
        routingSection: { ...section },
        duplicates,
        estimator: PROMPT_TOKEN_ESTIMATOR,
      };
    },
  };
}

/**
 * A loaded route names its own source. A recommended or refused route names only the
 * skill, so it belongs to the source that won name resolution in the same receipt, never
 * to a shadowed same-named source; with no winner it stays unattributed.
 */
function routeRow(
  route: SkillRouteFact,
  skills: readonly SkillSourceDecision[],
  identityOf: (decision: SkillSourceDecision) => {
    name: string;
    source: string | null;
    origin: string | null;
    path: string | null;
    digest: string | null;
  },
  row: (identity: ReturnType<typeof identityOf>) => MutableRow | null,
): MutableRow | null {
  const owner =
    route.source !== null
      ? skills.find((decision) => decision.source === route.source)
      : skills.find((decision) => decision.name === route.name && decision.state === "selected");
  if (owner !== undefined) return row(identityOf(owner));
  return row({
    name: route.name,
    source: route.source,
    origin: null,
    path: null,
    digest: route.digest,
  });
}

function freezeRow(row: MutableRow): SkillUsageRow {
  return {
    ...row,
    counts: { ...row.counts },
    reasons: { ...row.reasons },
    scopes: { ...row.scopes },
    body: { ...row.body },
    listing: { ...row.listing },
  };
}

const sum = (a: ContributionTotal, b: ContributionTotal): ContributionTotal => ({
  count: a.count + b.count,
  bytes: a.bytes + b.bytes,
  tokens: a.tokens + b.tokens,
  unestimated: a.unestimated + b.unestimated,
});

/** Explicit aggregation merges one source's generations and keeps the breakdown. */
function aggregateBySource(rows: readonly MutableRow[]): SkillUsageRow[] {
  const merged = new Map<
    string,
    { row: SkillUsageRow; versions: SkillUsageVersion[]; omitted: number }
  >();
  for (const next of rows) {
    const key = next.source ?? `name:${next.name}`;
    const version: SkillUsageVersion = {
      digest: next.digest,
      generation: next.generation,
      admissions: next.scopes.main + next.scopes.child + next.scopes.workflow,
    };
    const current = merged.get(key);
    if (current === undefined) {
      merged.set(key, {
        row: { ...freezeRow(next), generation: null },
        versions: [version],
        omitted: 0,
      });
      continue;
    }
    const a = current.row;
    const reasons: Record<string, number> = { ...a.reasons };
    for (const [reason, count] of Object.entries(next.reasons))
      if (
        reasons[reason] !== undefined ||
        Object.keys(reasons).length < SKILL_USAGE_LIMITS.reasonsPerRow
      )
        reasons[reason] = (reasons[reason] ?? 0) + count;
    current.row = {
      ...a,
      digest: next.last.at >= a.last.at ? next.digest : a.digest,
      counts: Object.fromEntries(
        SKILL_OBSERVATIONS.map((kind) => [kind, a.counts[kind] + next.counts[kind]]),
      ) as Record<SkillObservation, number>,
      reused: a.reused + next.reused,
      reasons,
      scopes: {
        main: a.scopes.main + next.scopes.main,
        child: a.scopes.child + next.scopes.child,
        workflow: a.scopes.workflow + next.scopes.workflow,
      },
      body: sum(a.body, next.body),
      listing: sum(a.listing, next.listing),
      first: next.first.at < a.first.at ? next.first : a.first,
      last: next.last.at >= a.last.at ? next.last : a.last,
    };
    if (current.versions.length < SKILL_USAGE_LIMITS.versionsPerRow) current.versions.push(version);
    else current.omitted++;
  }
  return [...merged.values()].map(({ row, versions, omitted }) => ({
    ...row,
    versions,
    versionsOmitted: omitted,
  }));
}
