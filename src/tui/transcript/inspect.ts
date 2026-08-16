/**
 * Inspection of tool, process, reasoning, and error blocks (#254).
 *
 * The inspector is a view over facts the block already carries. It does not
 * infer success from output text, does not fetch canonical sources, and does
 * not invent a dashboard. Kinds outside this set return `null`, which is how
 * the command registry says "this entry has no inspection" without a half-built
 * panel.
 *
 * Secret payloads stay withheld. A secret block is still inspectable: the
 * summary and kind remain visible, because a withheld block is not an invisible
 * one.
 */

import type { TerminalOutcome } from "../../domain/index.ts";
import {
  type BoundedText,
  blockKey,
  describeBlock,
  describeDisclosure,
  outcomeOf,
  type TranscriptBlock,
} from "../../presentation/index.ts";

export const INSPECTABLE_KINDS = [
  "tool-request",
  "tool-progress",
  "tool-result",
  "process-stream",
  "process-exit",
  "model-reasoning",
  "diagnostic",
] as const;

export type InspectableKind = (typeof INSPECTABLE_KINDS)[number];

export const INSPECTION_FAMILIES = ["tool", "process", "reasoning", "error"] as const;
export type InspectionFamily = (typeof INSPECTION_FAMILIES)[number];

export type InspectionFact = {
  readonly label: string;
  readonly value: string;
  readonly untrusted: boolean;
};

export type BlockInspection = {
  readonly family: InspectionFamily;
  readonly title: string;
  readonly key: string;
  readonly summary: string;
  readonly withheld: boolean;
  readonly outcome: TerminalOutcome | null;
  readonly facts: readonly InspectionFact[];
};

type InspectableBlock = Extract<TranscriptBlock, { kind: InspectableKind }>;

export function isInspectableKind(kind: TranscriptBlock["kind"]): kind is InspectableKind {
  return (INSPECTABLE_KINDS as readonly string[]).includes(kind);
}

function isInspectable(block: TranscriptBlock): block is InspectableBlock {
  return isInspectableKind(block.kind);
}

export function hasDiagnostics(block: TranscriptBlock): boolean {
  if (inspectBlock(block) === null) {
    return false;
  }
  const outcome = outcomeOf(block);
  return outcome !== null && outcome.kind !== "completed";
}

export function inspectionFor(
  blocks: readonly TranscriptBlock[],
  key: string | null,
): BlockInspection | null {
  if (key === null) {
    return null;
  }
  const block = blocks.find((item) => blockKey(item.anchor) === key);
  return block === undefined ? null : inspectBlock(block);
}

export function inspectBlock(block: TranscriptBlock): BlockInspection | null {
  if (!isInspectable(block)) {
    return null;
  }
  const inspectable: InspectableBlock = block;
  const withheld = inspectable.sensitivity === "secret";
  return {
    family: familyOf(inspectable.kind),
    title: describeBlock(inspectable),
    key: blockKey(inspectable.anchor),
    summary:
      inspectable.summary.text === ""
        ? describeDisclosure(inspectable.summary.disclosure)
        : inspectable.summary.text,
    withheld,
    outcome: outcomeOf(inspectable),
    facts: factsOf(inspectable, withheld),
  };
}

/**
 * Facts that fit in an overlay of this height, plus how many did not.
 *
 * The summary always takes the first row when there is one. Remaining rows
 * go to facts, and a count of what was dropped takes a row only when at least
 * one fact can sit beside it — a count with no fact is the same overdraw the
 * activity rail already refused.
 */
export function sliceInspection(
  inspection: BlockInspection,
  rows: number,
): {
  readonly showSummary: boolean;
  readonly facts: readonly InspectionFact[];
  readonly hidden: number;
} {
  if (rows < 1) {
    return { showSummary: false, facts: [], hidden: inspection.facts.length };
  }
  if (rows === 1) {
    return { showSummary: true, facts: [], hidden: inspection.facts.length };
  }
  const room = rows - 1;
  const needsNotice = inspection.facts.length > room;
  const factBudget = needsNotice && room >= 2 ? room - 1 : room;
  const facts = inspection.facts.slice(0, Math.max(0, factBudget));
  return {
    showSummary: true,
    facts,
    hidden: inspection.facts.length - facts.length,
  };
}

export function describeTerminalOutcome(outcome: TerminalOutcome): string {
  switch (outcome.kind) {
    case "completed":
      return "completed";
    case "failed":
      return `failed (${outcome.effect} effect)`;
    case "cancelled":
      return `cancelled (${outcome.effect} effect)`;
    case "timed-out":
      return `timed out (${outcome.effect} effect)`;
    case "uncertain":
      return "uncertain (inspect before retry)";
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

function familyOf(kind: InspectableKind): InspectionFamily {
  switch (kind) {
    case "tool-request":
    case "tool-progress":
    case "tool-result":
      return "tool";
    case "process-stream":
    case "process-exit":
      return "process";
    case "model-reasoning":
      return "reasoning";
    case "diagnostic":
      return "error";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function factsOf(block: InspectableBlock, withheld: boolean): readonly InspectionFact[] {
  const facts: InspectionFact[] = [
    trusted("kind", block.kind),
    trusted("source", block.source),
    trusted("sensitivity", block.sensitivity),
  ];
  if (block.invocationId !== null) {
    facts.push(trusted("invocation", block.invocationId));
  }
  if (block.artifactIds.length > 0) {
    facts.push(trusted("artifacts", String(block.artifactIds.length)));
  }

  switch (block.kind) {
    case "tool-request":
      facts.push(trusted("capability", block.capability));
      facts.push(...payload("input", block.input, withheld));
      break;
    case "tool-progress":
      facts.push(...payload("progress", block.note, withheld));
      break;
    case "tool-result":
      facts.push(trusted("capability", block.capability));
      facts.push(...payload("output", block.output, withheld));
      facts.push(trusted("outcome", describeTerminalOutcome(block.outcome)));
      break;
    case "process-stream":
      facts.push(trusted("channel", block.channel));
      facts.push(...payload("output", block.output, withheld));
      break;
    case "process-exit":
      facts.push(
        trusted("exit", block.exitCode === null ? "no exit code" : String(block.exitCode)),
      );
      facts.push(trusted("outcome", describeTerminalOutcome(block.outcome)));
      break;
    case "model-reasoning":
      facts.push(...payload("reasoning", block.text, withheld));
      break;
    case "diagnostic":
      facts.push(...payload("diagnostic", block.note, withheld));
      if (block.outcome !== null) {
        facts.push(trusted("outcome", describeTerminalOutcome(block.outcome)));
      }
      break;
    default: {
      const exhaustive: never = block;
      return exhaustive;
    }
  }
  return facts;
}

function trusted(label: string, value: string): InspectionFact {
  return { label, value, untrusted: false };
}

function payload(
  label: string,
  content: BoundedText,
  withheld: boolean,
): readonly InspectionFact[] {
  if (withheld) {
    return [trusted(label, "Withheld. This block is secret and has no expansion that reveals it.")];
  }
  const facts: InspectionFact[] = [];
  if (content.disclosure.kind === "complete" && content.text !== "") {
    facts.push({ label, value: content.text, untrusted: true });
    return facts;
  }
  if (content.text !== "" && content.disclosure.kind === "truncated") {
    facts.push({ label, value: content.text, untrusted: true });
  }
  facts.push(trusted(label, describeDisclosure(content.disclosure)));
  return facts;
}
