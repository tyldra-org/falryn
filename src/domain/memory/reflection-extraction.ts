/**
 * Deterministic turn-end extraction (#882). It reads only typed committed events: user
 * message text recorded inline by turns whose terminal outcome is completed, and the
 * terminal status of capability invocations in those turns. It proposes candidates; it
 * never admits memory, calls a model or treats repository, tool or model text as a source.
 */
import type { RuntimeEvent } from "../sessions/event.ts";
import type { reflectionCandidateInputSchema } from "./reflection.ts";
import { REFLECTION_LIMITS, type ReflectionRange } from "./reflection.ts";

export const TURN_END_TRANSFORM = "turn-end-deterministic-v1";
export const EXTRACTION_LIMITS = Object.freeze({
  sentencesPerMessage: 64,
  sentenceLength: 600,
  repeatedFailures: 2,
});
type CandidateInput = import("zod").infer<typeof reflectionCandidateInputSchema>;
type Kind = CandidateInput["kind"];

/** First matching rule wins; each names the sentence shape it accepts. */
const RULES: readonly {
  readonly kind: Kind;
  readonly label: string;
  readonly pattern: RegExp;
  readonly confidence: number;
  readonly contradiction: CandidateInput["contradiction"];
}[] = [
  {
    kind: "correction",
    label: "Correction",
    pattern:
      /^(?:no[,.!:]\s+|actually[,:\s]|correction[:,]\s*|that'?s (?:wrong|incorrect|not right)\b|that is (?:wrong|incorrect)\b)/iu,
    confidence: 0.6,
    contradiction: "possible",
  },
  {
    kind: "user-preference",
    label: "Preference",
    pattern:
      /^(?:please\s+)?(?:always|never|prefer)\b|\b(?:i|we)\s+(?:prefer|would rather|like to|want you to)\b/iu,
    confidence: 0.6,
    contradiction: "none",
  },
  {
    kind: "decision",
    label: "Decision",
    pattern:
      /\b(?:we(?:'ve| have)?\s+(?:decided|agreed|chosen|chose)|let'?s go with)\b|^decision:/iu,
    confidence: 0.55,
    contradiction: "none",
  },
  {
    kind: "workflow-convention",
    label: "Changed assumption",
    pattern: /\b(?:from now on|going forward|no longer)\b/iu,
    confidence: 0.55,
    contradiction: "possible",
  },
  {
    kind: "recurring-task-context",
    label: "Unresolved task",
    pattern:
      /\b(?:todo|to-do|follow[- ]up|remind me to)\b|\blater,?\s+(?:we|i)\s+(?:need|should|must)\b/iu,
    confidence: 0.5,
    contradiction: "none",
  },
  {
    kind: "project-fact",
    label: "Project fact",
    pattern: /^(?:note|fyi|remember)(?:\s+that)?[:,]?\s+\S/iu,
    confidence: 0.5,
    contradiction: "none",
  },
];

/** Sentences of plain prose; fenced code is excluded rather than mined. */
function sentences(text: string): string[] {
  const prose = text.replace(/```[\s\S]*?(?:```|$)/gu, "\n");
  return prose
    .split(/\n+|(?<=[.!?])\s+/u)
    .map((value) => value.trim().replace(/\s+/gu, " "))
    .filter((value) => value.length >= 8 && value.length <= EXTRACTION_LIMITS.sentenceLength)
    .slice(0, EXTRACTION_LIMITS.sentencesPerMessage);
}

export type ExtractionSegment = {
  readonly range: ReflectionRange;
  readonly disposition: "processed" | "empty" | "unavailable";
  readonly candidates: readonly CandidateInput[];
};
export type TurnEndExtraction = {
  /** Contiguous ranges covering the request exactly, in order. */
  readonly segments: readonly ExtractionSegment[];
  readonly scannedEvents: number;
  readonly scannedBytes: number;
  /** Candidates not proposed because the per-request limit was reached. */
  readonly omittedCandidates: number;
  /** User messages whose text is not inline and was not read. */
  readonly unavailableMessages: number;
};

/**
 * Extract candidates from the events of one request range, which must be the committed
 * events with exactly those sequences. Unreadable user messages become their own
 * unavailable ranges, so coverage never claims evidence that was not processed.
 */
export function extractTurnEnd(
  events: readonly RuntimeEvent[],
  range: ReflectionRange,
): TurnEndExtraction {
  const completedTurns = new Set(
    events.flatMap((event) =>
      event.kind === "turn.completed" && event.payload.outcome.kind === "completed"
        ? [String(event.correlation.turnId)]
        : [],
    ),
  );
  const turnOf = (event: RuntimeEvent) =>
    "turnId" in event.correlation ? String(event.correlation.turnId) : null;
  const candidates = new Map<number, CandidateInput[]>();
  const unavailable = new Set<number>();
  const seen = new Set<string>();
  let proposed = 0;
  let omitted = 0;
  let bytes = 0;
  const propose = (sequence: number, candidate: CandidateInput) => {
    const key = candidate.kind + "\u0000" + candidate.content.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (proposed >= REFLECTION_LIMITS.candidates) {
      omitted += 1;
      return;
    }
    proposed += 1;
    candidates.set(sequence, [...(candidates.get(sequence) ?? []), candidate]);
  };
  const failures = new Map<string, { sequences: number[]; events: string[] }>();
  for (const event of events) {
    const sequence = Number(event.sequence);
    const turn = turnOf(event);
    if (turn === null || !completedTurns.has(turn)) continue;
    if (event.kind === "capability.invocation.completed") {
      const status = event.payload.observedStatus ?? event.payload.outcome.kind;
      if (status === "failed" || status === "timed-out") {
        const key = String(event.capabilityId);
        const entry = failures.get(key) ?? { sequences: [], events: [] };
        entry.sequences.push(sequence);
        entry.events.push(String(event.eventId));
        failures.set(key, entry);
      }
      continue;
    }
    if (
      event.kind !== "history.recorded" ||
      event.payload.type !== "message" ||
      event.payload.role !== "user" ||
      event.payload.completion !== "complete"
    )
      continue;
    const evidence = event.payload.evidence;
    if (evidence.availability !== "inline") {
      unavailable.add(sequence);
      continue;
    }
    bytes += evidence.byteLength;
    for (const sentence of sentences(evidence.text)) {
      const rule = RULES.find((candidate) => candidate.pattern.test(sentence));
      if (rule === undefined) continue;
      propose(sequence, {
        subject: rule.label + ": " + sentence.slice(0, 96),
        content: sentence.slice(0, REFLECTION_LIMITS.contentBytes),
        sources: [String(event.eventId)],
        artifacts: [],
        method: "deterministic",
        proposedScope: "workspace",
        kind: rule.kind,
        confidence: rule.confidence,
        sensitivity: "user-content",
        contradiction: rule.contradiction,
        supersedes: [],
      });
    }
  }
  // A supported operational aggregate: the same capability failing repeatedly.
  for (const [capability, entry] of [...failures].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (entry.sequences.length < EXTRACTION_LIMITS.repeatedFailures) continue;
    const sequence = entry.sequences.at(-1) ?? range.first;
    propose(sequence, {
      subject: "Repeated capability failure: " + capability.slice(0, 96),
      content:
        capability.slice(0, 256) +
        " failed " +
        entry.sequences.length +
        " times in one committed range.",
      sources: entry.events.slice(0, REFLECTION_LIMITS.provenance),
      artifacts: [],
      method: "deterministic",
      proposedScope: "workspace",
      kind: "reusable-technical-knowledge",
      confidence: 0.4,
      sensitivity: "user-content",
      contradiction: "none",
      supersedes: [],
    });
  }
  // Candidates attach to the segment holding their last source; unavailable messages
  // split the range so each processed segment contains all of its candidates' sources.
  const segments: ExtractionSegment[] = [];
  let start = range.first;
  const close = (last: number) => {
    if (last < start) return;
    const inside = [...candidates]
      .filter(([sequence]) => sequence >= start && sequence <= last)
      .flatMap(([, list]) => list);
    segments.push({
      range: { first: start, last },
      disposition: inside.length > 0 ? "processed" : "empty",
      candidates: inside,
    });
  };
  // Each split costs up to two publications; past the limit the rest stays unavailable.
  const splits = [...unavailable].sort((a, b) => a - b);
  const room = Math.floor((REFLECTION_LIMITS.publications - 2) / 2);
  for (const [index, sequence] of splits.entries()) {
    if (index >= room) {
      segments.push({
        range: { first: start, last: range.last },
        disposition: "unavailable",
        candidates: [],
      });
      start = range.last + 1;
      break;
    }
    close(sequence - 1);
    segments.push({
      range: { first: sequence, last: sequence },
      disposition: "unavailable",
      candidates: [],
    });
    start = sequence + 1;
  }
  close(range.last);
  // An aggregate whose sources span an unavailable split is not proposed.
  const valid = segments.map((segment) => ({
    ...segment,
    candidates: segment.candidates.filter((candidate) =>
      candidate.sources.every((id) => {
        const source = events.find((event) => String(event.eventId) === id);
        const at = source === undefined ? -1 : Number(source.sequence);
        return at >= segment.range.first && at <= segment.range.last;
      }),
    ),
  }));
  return {
    segments: valid.map((segment) =>
      segment.disposition === "processed" && segment.candidates.length === 0
        ? { ...segment, disposition: "empty" }
        : segment,
    ),
    scannedEvents: events.length,
    scannedBytes: bytes,
    omittedCandidates: omitted,
    unavailableMessages: unavailable.size,
  };
}
