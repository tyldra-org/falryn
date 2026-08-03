/**
 * A block of every declared kind.
 *
 * Eleven of the sixteen kinds have no producer in this build, so without this
 * corpus they would be types nothing ever constructs — which is to say,
 * untested declarations that happen to compile. Every consumer that claims to
 * be total over the block model is walked across this list, so "total" means a
 * function was actually called with each kind rather than that a switch looked
 * exhaustive.
 *
 * These fixtures are also the replay corpus. When the reducer's output changes,
 * the generation goes up and the expectations here change with it in the same
 * commit; a change to one without the other is the failure the replay test
 * exists to catch.
 *
 * Nothing here contains anything secret. A fixture is checked into the
 * repository, and a fixture that demonstrated secret handling by holding a
 * credential would be the leak it was written to prevent — so the sensitive and
 * secret cases carry *redactions*, which is what a real one would carry too.
 */

import type { ArtifactId, ConfigurationGeneration, Timestamp } from "../../domain/index.ts";
import {
  artifactId,
  configurationGeneration,
  invocationId,
  modelAttemptId,
  sessionId,
  timestampFromEpochMilliseconds,
  turnId,
} from "../../domain/index.ts";
import type { BlockAnchor, TranscriptBlock, TranscriptBlockKind } from "./blocks.ts";
import { TRANSCRIPT_BLOCK_KINDS } from "./blocks.ts";
import { bound, complete, omitted, redacted } from "./disclosure.ts";
import { TRANSCRIPT_PROJECTION_GENERATION } from "./generation.ts";

export const FIXTURE_AT: Timestamp = timestampFromEpochMilliseconds(Date.UTC(2026, 7, 1, 9, 30, 0));

export const FIXTURE_SESSION = sessionId.from("session-fixture");
export const FIXTURE_TURN = turnId.from("turn-fixture");
export const FIXTURE_MODEL_ATTEMPT = modelAttemptId.from("attempt-fixture");
export const FIXTURE_INVOCATION = invocationId.from("invocation-fixture");
export const FIXTURE_ARTIFACT: ArtifactId = artifactId.from("artifact-fixture");
export const FIXTURE_GENERATION: ConfigurationGeneration = configurationGeneration.from(4);

function spine(anchor: BlockAnchor, order: number) {
  return {
    anchor,
    occurredAt: FIXTURE_AT,
    order,
    sensitivity: "ordinary",
    invocationId: null,
    artifactIds: [],
    renderGeneration: TRANSCRIPT_PROJECTION_GENERATION,
  } as const;
}

function declared(key: string, order: number): BlockAnchor & { readonly of: "declared" } {
  return { of: "declared", key: `${key}-${order}` };
}

/**
 * One block per declared kind, in declaration order.
 *
 * Deliberately not generated from the kind list: a generated fixture would
 * construct whatever the type demanded and prove only that the type is
 * inhabited. These are written out so each one is a plausible thing a user
 * would actually see, which is what makes a rendering test over them worth
 * running.
 */
export function everyBlockKind(): readonly TranscriptBlock[] {
  return [
    {
      ...spine(declared("user-input", 0), 0),
      kind: "user-input",
      source: "user",
      status: "final",
      summary: complete("Rename the port."),
      text: complete("Rename the port and update every caller."),
    },
    {
      ...spine(declared("model-text", 1), 1),
      kind: "model-text",
      source: "model",
      status: "final",
      summary: complete("Found four callers."),
      text: complete("There are four callers. Three are tests."),
    },
    {
      ...spine(declared("model-reasoning", 2), 2),
      kind: "model-reasoning",
      source: "model",
      status: "final",
      summary: complete("Reasoning withheld."),
      // Reasoning is the canonical sensitive case: bounded metadata rather than
      // content, and withheld rather than shortened.
      text: redacted("reasoning is not projected by default"),
    },
    {
      ...spine({ of: "model-attempt", modelAttemptId: FIXTURE_MODEL_ATTEMPT }, 3),
      kind: "model-outcome",
      source: "model",
      status: "final",
      summary: complete("Model attempt finished."),
      outcome: { kind: "completed" },
    },
    {
      ...spine(declared("tool-request", 4), 4),
      kind: "tool-request",
      source: "tool",
      status: "in-progress",
      summary: complete("Running search."),
      capability: "search",
      input: complete("port"),
    },
    {
      ...spine(declared("tool-progress", 5), 5),
      kind: "tool-progress",
      source: "tool",
      status: "in-progress",
      summary: complete("Searching."),
      note: complete("Scanned 120 files."),
    },
    {
      ...spine({ of: "invocation", invocationId: FIXTURE_INVOCATION }, 6),
      kind: "tool-result",
      source: "tool",
      status: "final",
      summary: complete("Ran search."),
      capability: "search",
      // Truncated with a result count: the case the extent's nullable `results`
      // field exists for.
      output: bound("match\n".repeat(900), { bytes: 64, lines: 8 }, 900),
      outcome: { kind: "completed" },
    },
    {
      ...spine(declared("process-stream", 7), 7),
      kind: "process-stream",
      source: "process",
      status: "in-progress",
      summary: complete("Building."),
      channel: "stdout",
      output: complete("compiling 3 modules"),
    },
    {
      ...spine(declared("process-exit", 8), 8),
      kind: "process-exit",
      source: "process",
      status: "final",
      summary: complete("Build failed."),
      exitCode: 1,
      // Attractive text above, a failure here. The pair a reader has to be able
      // to tell apart, and the reason `outcomeOf` is the only success authority.
      outcome: { kind: "failed", effect: "partial" },
    },
    {
      ...spine(declared("file-change", 9), 9),
      kind: "file-change",
      source: "tool",
      status: "final",
      summary: complete("Patched one file."),
      change: "patch",
      path: complete("src/domain/port.ts"),
      detail: complete("2 insertions, 2 deletions"),
    },
    {
      ...spine(declared("repository-activity", 10), 10),
      kind: "repository-activity",
      source: "tool",
      status: "final",
      summary: complete("Created a checkpoint."),
      activity: "checkpoint",
      detail: complete("before renaming the port"),
    },
    {
      ...spine(declared("task-progress", 11), 11),
      kind: "task-progress",
      source: "runtime",
      status: "in-progress",
      summary: complete("Indexing."),
      label: complete("Indexing the workspace"),
      // Open-ended work: a denominator nobody knows stays null.
      completed: 42,
      total: null,
    },
    {
      ...spine({ of: "turn", turnId: FIXTURE_TURN }, 12),
      kind: "turn-outcome",
      source: "runtime",
      status: "final",
      summary: complete("Turn cancelled."),
      outcome: { kind: "cancelled", effect: "partial" },
    },
    {
      ...spine({ of: "session", sessionId: FIXTURE_SESSION }, 13),
      kind: "notice",
      source: "runtime",
      status: "final",
      summary: complete("Session started."),
      note: complete("A session was opened. Nothing has run in it yet."),
    },
    {
      ...spine(declared("diagnostic", 14), 14),
      kind: "diagnostic",
      source: "runtime",
      status: "final",
      summary: complete("The provider is unreachable."),
      note: omitted("no diagnostics collector ran"),
      outcome: { kind: "uncertain", effect: "uncertain" },
    },
    {
      ...spine(declared("artifact", 15), 15),
      kind: "artifact",
      source: "tool",
      status: "final",
      summary: complete("Captured the build log."),
      artifactIds: [FIXTURE_ARTIFACT],
      artifactId: FIXTURE_ARTIFACT,
      mediaType: "text/plain",
      availability: "available",
    },
  ];
}

/** The kinds the corpus above covers, for a control that compares it to the union. */
export function coveredKinds(): readonly TranscriptBlockKind[] {
  return everyBlockKind().map((block) => block.kind);
}

/** Every kind the union declares, for the same control. */
export const ALL_KINDS: readonly TranscriptBlockKind[] = TRANSCRIPT_BLOCK_KINDS;
