/**
 * Bounded review, advisor, and simplify modes (#285).
 *
 * Deterministic inspection first. Findings and proposals are advice: this
 * module does not mutate files, apply patches, or call a model.
 */

import { z } from "zod";

import { assertNever, err, ok, type Result } from "./result.ts";

export const TASK_ADVISOR_VERSION = "task-advisor.v1";
export const TASK_ADVISOR_SOURCE = "deterministic-inspection";
export const MAX_ADVISOR_QUESTION_BYTES = 1_024;
export const MAX_ADVISOR_EVIDENCE = 16;
export const MAX_ADVISOR_RUBRIC = 16;
export const MAX_ADVISOR_PROPOSALS = 16;
export const MAX_ADVISOR_TEXT_BYTES = 512;

export const TASK_ADVISOR_MODES = ["review", "advisor", "simplify"] as const;
export type TaskAdvisorMode = (typeof TASK_ADVISOR_MODES)[number];

export type TaskAdvisorErrorCode =
  | "cancelled"
  | "empty"
  | "malformed"
  | "oversized"
  | "secret"
  | "unsupported";

export type TaskAdvisorError = {
  readonly kind: "task-advisor";
  readonly code: TaskAdvisorErrorCode;
  readonly field: string | null;
};

export type TaskAdvisorProvenance = {
  readonly version: typeof TASK_ADVISOR_VERSION;
  readonly source: typeof TASK_ADVISOR_SOURCE;
  readonly model: null;
};

export type TaskAdvisorFinding = {
  readonly findingId: string;
  readonly mode: TaskAdvisorMode;
  readonly location: string | null;
  readonly statement: string;
  readonly suggestedVerification: string;
};

export type TaskAdvisorProposal = {
  readonly path: string;
  readonly summary: string;
  readonly applied: false;
};

export type TaskAdvisorAdvice = {
  readonly mode: TaskAdvisorMode;
  readonly question: string;
  readonly findings: readonly TaskAdvisorFinding[];
  readonly proposals: readonly TaskAdvisorProposal[];
  readonly omittedEvidence: readonly string[];
  readonly provenance: TaskAdvisorProvenance;
};

export type TaskAdvisorInput = {
  readonly mode: unknown;
  readonly question: unknown;
  readonly evidence?: unknown;
  readonly rubric?: unknown;
  readonly proposed?: unknown;
  readonly model?: unknown;
};

const encoder = new TextEncoder();

function advisorError(code: TaskAdvisorErrorCode, field: string | null): TaskAdvisorError {
  return { kind: "task-advisor", code, field };
}

export function describeTaskAdvisorError(error: TaskAdvisorError): string {
  const field = error.field === null ? "advice" : error.field;
  switch (error.code) {
    case "cancelled":
      return `cancelled ${field}`;
    case "empty":
      return `empty ${field}`;
    case "malformed":
      return `malformed ${field}`;
    case "oversized":
      return `oversized ${field}`;
    case "secret":
      return `secret ${field}`;
    case "unsupported":
      return `unsupported ${field}`;
    default:
      return assertNever(error.code, "unhandled task-advisor error");
  }
}

function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

function parseBoundedText(
  value: unknown,
  field: string,
  maxBytes: number,
): Result<string, TaskAdvisorError> {
  if (typeof value !== "string") {
    return err(advisorError("malformed", field));
  }
  if (value.includes("\0")) {
    return err(advisorError("malformed", field));
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return err(advisorError("empty", field));
  }
  if (byteLength(trimmed) > maxBytes) {
    return err(advisorError("oversized", field));
  }
  return ok(trimmed);
}

const evidenceSchema = z
  .object({
    id: z.string(),
    location: z.string().optional(),
    excerpt: z.string().optional(),
  })
  .strict();

const proposedSchema = z
  .object({
    path: z.string(),
    summary: z.string(),
  })
  .strict();

function isMode(value: unknown): value is TaskAdvisorMode {
  return typeof value === "string" && (TASK_ADVISOR_MODES as readonly string[]).includes(value);
}

function nextFindingId(index: number): string {
  return `finding-${index + 1}`;
}

/**
 * Runs one bounded review, advisor, or simplify pass over declared evidence.
 * Extra mutation fields and a present model identity fail closed.
 */
export function adviseTask(
  input: TaskAdvisorInput,
  signal?: AbortSignal,
): Result<TaskAdvisorAdvice, TaskAdvisorError> {
  if (signal?.aborted) {
    return err(advisorError("cancelled", "signal"));
  }
  if (input.model !== undefined && input.model !== null) {
    return err(advisorError("unsupported", "model"));
  }
  if (!isMode(input.mode)) {
    return err(advisorError("malformed", "mode"));
  }
  const question = parseBoundedText(input.question, "question", MAX_ADVISOR_QUESTION_BYTES);
  if (!question.ok) {
    return question;
  }

  const evidence: { id: string; location: string | null; excerpt: string | null }[] = [];
  const omittedEvidence: string[] = [];
  if (input.evidence !== undefined) {
    if (!Array.isArray(input.evidence)) {
      return err(advisorError("malformed", "evidence"));
    }
    if (input.evidence.length > MAX_ADVISOR_EVIDENCE) {
      return err(advisorError("oversized", "evidence"));
    }
    const seen = new Set<string>();
    for (const [index, entry] of input.evidence.entries()) {
      const parsed = evidenceSchema.safeParse(entry);
      if (!parsed.success) {
        return err(advisorError("malformed", `evidence.${index}`));
      }
      const id = parseBoundedText(parsed.data.id, `evidence.${index}.id`, MAX_ADVISOR_TEXT_BYTES);
      if (!id.ok) {
        return id;
      }
      if (seen.has(id.value)) {
        return err(advisorError("malformed", `evidence.${index}.id`));
      }
      seen.add(id.value);
      let location: string | null = null;
      if (parsed.data.location !== undefined) {
        const parsedLocation = parseBoundedText(
          parsed.data.location,
          `evidence.${index}.location`,
          MAX_ADVISOR_TEXT_BYTES,
        );
        if (!parsedLocation.ok) {
          return parsedLocation;
        }
        location = parsedLocation.value;
      }
      let excerpt: string | null = null;
      if (parsed.data.excerpt !== undefined) {
        const parsedExcerpt = parseBoundedText(
          parsed.data.excerpt,
          `evidence.${index}.excerpt`,
          MAX_ADVISOR_TEXT_BYTES,
        );
        if (!parsedExcerpt.ok) {
          return parsedExcerpt;
        }
        excerpt = parsedExcerpt.value;
      } else {
        omittedEvidence.push(id.value);
      }
      evidence.push({ id: id.value, location, excerpt });
    }
  }

  const rubric: string[] = [];
  if (input.rubric !== undefined) {
    if (!Array.isArray(input.rubric)) {
      return err(advisorError("malformed", "rubric"));
    }
    if (input.rubric.length > MAX_ADVISOR_RUBRIC) {
      return err(advisorError("oversized", "rubric"));
    }
    for (const [index, entry] of input.rubric.entries()) {
      const item = parseBoundedText(entry, `rubric.${index}`, MAX_ADVISOR_TEXT_BYTES);
      if (!item.ok) {
        return item;
      }
      rubric.push(item.value);
    }
  }

  const proposed: TaskAdvisorProposal[] = [];
  if (input.proposed !== undefined) {
    if (input.mode !== "simplify") {
      return err(advisorError("malformed", "proposed"));
    }
    if (!Array.isArray(input.proposed)) {
      return err(advisorError("malformed", "proposed"));
    }
    if (input.proposed.length > MAX_ADVISOR_PROPOSALS) {
      return err(advisorError("oversized", "proposed"));
    }
    if (input.proposed.length === 0) {
      return err(advisorError("empty", "proposed"));
    }
    const seen = new Set<string>();
    for (const [index, entry] of input.proposed.entries()) {
      const parsed = proposedSchema.safeParse(entry);
      if (!parsed.success) {
        return err(advisorError("malformed", `proposed.${index}`));
      }
      const path = parseBoundedText(
        parsed.data.path,
        `proposed.${index}.path`,
        MAX_ADVISOR_TEXT_BYTES,
      );
      if (!path.ok) {
        return path;
      }
      if (seen.has(path.value)) {
        return err(advisorError("malformed", `proposed.${index}.path`));
      }
      seen.add(path.value);
      const summary = parseBoundedText(
        parsed.data.summary,
        `proposed.${index}.summary`,
        MAX_ADVISOR_TEXT_BYTES,
      );
      if (!summary.ok) {
        return summary;
      }
      proposed.push({ path: path.value, summary: summary.value, applied: false });
    }
  }

  const findings: TaskAdvisorFinding[] = [];
  switch (input.mode) {
    case "review": {
      if (evidence.length === 0) {
        return err(advisorError("empty", "evidence"));
      }
      for (const item of evidence) {
        if (item.excerpt === null) {
          continue;
        }
        findings.push({
          findingId: nextFindingId(findings.length),
          mode: "review",
          location: item.location,
          statement: `Review evidence ${item.id}: ${item.excerpt}`,
          suggestedVerification: `Confirm ${item.id} against the declared rubric`,
        });
      }
      break;
    }
    case "advisor": {
      if (rubric.length === 0) {
        return err(advisorError("empty", "rubric"));
      }
      const haystack = [question.value, ...evidence.flatMap((item) => item.excerpt ?? [])].join(
        "\n",
      );
      for (const item of rubric) {
        if (haystack.includes(item)) {
          continue;
        }
        findings.push({
          findingId: nextFindingId(findings.length),
          mode: "advisor",
          location: null,
          statement: `Missing evidence for rubric: ${item}`,
          suggestedVerification: `Collect evidence that addresses: ${item}`,
        });
      }
      break;
    }
    case "simplify": {
      if (proposed.length === 0) {
        return err(advisorError("empty", "proposed"));
      }
      break;
    }
    default:
      return assertNever(input.mode, "unhandled task-advisor mode");
  }

  return ok({
    mode: input.mode,
    question: question.value,
    findings,
    proposals: proposed,
    omittedEvidence,
    provenance: {
      version: TASK_ADVISOR_VERSION,
      source: TASK_ADVISOR_SOURCE,
      model: null,
    },
  });
}
