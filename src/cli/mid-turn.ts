/**
 * Headless mid-turn classify and JSONL projection (#613).
 *
 * Requires an explicit intent — missing or ambiguous intent fails closed with
 * no prompt. Emits CLI event records for each mid-turn semantic event, then a
 * terminal result. Queue order and depth travel on every event wire object.
 *
 * Product command-tree wiring attaches when the live turn loop owns a durable
 * mid-turn service; this module is the headless classify + JSONL contract.
 */

import {
  createInterruptionPolicy,
  createMidTurnInputService,
  createTurnCoordinator,
  type MidTurnInputService,
} from "../application/index.ts";
import {
  configurationGeneration,
  createManualClock,
  describeMidTurnClassifyError,
  type FalrynError,
  FIRST_SEQUENCE,
  type FollowUpId,
  followUpId as followUpIdCodec,
  followUpQueueOrder,
  MID_TURN_INTENTS,
  type MidTurnIntent,
  type MidTurnRequestSnapshot,
  type MidTurnSemanticEvent,
  modelAttemptId,
  nextSequence,
  type Sequence,
  sessionId as sessionIdCodec,
  type TerminalOutcome,
  type Timestamp,
  timestampFromEpochMilliseconds,
  toWireMidTurnEvent,
  traceId,
  turnId,
  workspaceId,
} from "../domain/index.ts";
import {
  COMMAND_RESULT_SCHEMA_FAMILY,
  COMMAND_RESULT_SCHEMA_VERSION,
  type CommandEffect,
  READ_ONLY_EFFECT,
} from "./result.ts";
import { cliEventRecord, cliResultRecord, encodeCliRecord } from "./schema.ts";

export const MID_TURN_CLASSIFY_COMMAND = "mid-turn.classify" as const;

export type MidTurnClassifyPayload = {
  readonly classification: string;
  readonly sessionId: string;
  readonly followUpId: string | null;
  readonly queueDepth: number;
  readonly queueOrder: readonly string[];
  readonly events: readonly Record<string, unknown>[];
};

export type MidTurnClassifyResult = {
  readonly schemaFamily: typeof COMMAND_RESULT_SCHEMA_FAMILY;
  readonly schemaVersion: number;
  readonly command: typeof MID_TURN_CLASSIFY_COMMAND;
  readonly outcome: TerminalOutcome;
  readonly effect: CommandEffect;
  readonly payload: MidTurnClassifyPayload | null;
  readonly errors: readonly FalrynError[];
  readonly warnings: readonly unknown[];
  readonly omissions: readonly unknown[];
  readonly truncation: readonly unknown[];
  readonly artifacts: readonly { readonly artifactId: string }[];
  readonly correlation: {
    readonly workspaceId: null;
    readonly sessionId: null;
    readonly turnId: null;
    readonly traceId: null;
    readonly scopeId: null;
    readonly invocationId: null;
    readonly capabilityId: null;
    readonly eventId: null;
  };
};

export type MidTurnClassifyArguments = {
  readonly intent: string | null;
  readonly text: string;
  readonly sessionId?: string;
  readonly followUpId?: string;
};

/**
 * Resolve a CLI `--intent` value. Missing or unknown values fail closed.
 */
export function resolveMidTurnIntent(
  raw: string | null | undefined,
):
  | { readonly ok: true; readonly intent: MidTurnIntent }
  | { readonly ok: false; readonly reason: string } {
  if (raw === null || raw === undefined || raw.trim() === "") {
    return {
      ok: false,
      reason: "mid-turn classify requires --intent steer, follow-up, or interrupt",
    };
  }
  const trimmed = raw.trim();
  if ((MID_TURN_INTENTS as readonly string[]).includes(trimmed)) {
    return { ok: true, intent: trimmed as MidTurnIntent };
  }
  return {
    ok: false,
    reason: `mid-turn intent "${trimmed}" is not steer, follow-up, or interrupt`,
  };
}

/** In-process active turn so headless classify can run without a live shell. */
export function createHeadlessMidTurnService(options?: {
  readonly sessionId?: string;
  readonly nextFollowUpId?: () => FollowUpId;
}): MidTurnInputService {
  const sid = sessionIdCodec.from(options?.sessionId ?? "session-headless");
  const coordinator = createTurnCoordinator();
  const generation = configurationGeneration.from(0);
  const service = createMidTurnInputService({
    sessionId: sid,
    coordinator,
    interruption: createInterruptionPolicy(createManualClock()),
    ...(options?.nextFollowUpId === undefined ? {} : { nextFollowUpId: options.nextFollowUpId }),
  });
  const started = coordinator.start({
    turnId: turnId.from("turn-headless-1"),
    sessionId: sid,
    workspaceId: workspaceId.from("workspace-headless"),
    traceId: traceId.from("trace-headless"),
    configurationGeneration: generation,
  });
  if (!started.ok) {
    throw new Error("headless mid-turn harness failed to start a turn");
  }
  for (const command of [
    "begin-orienting",
    "begin-assembling-context",
    "begin-awaiting-model",
  ] as const) {
    const applied = coordinator.apply({
      turnId: turnId.from("turn-headless-1"),
      command,
      configurationGeneration: generation,
    });
    if (!applied.ok) {
      throw new Error(`headless mid-turn harness failed on ${command}`);
    }
  }
  service.syncFromTurn(coordinator.get(turnId.from("turn-headless-1")));
  service.setActiveAttempt(modelAttemptId.from("attempt-headless-1"));
  return service;
}

export function projectMidTurnEventsToJsonl(input: {
  readonly events: readonly MidTurnSemanticEvent[];
  readonly queueOrder: readonly string[];
  readonly occurredAt: Timestamp;
  readonly result: MidTurnClassifyResult;
}): { readonly lines: readonly string[]; readonly skipped: readonly string[] } {
  const lines: string[] = [];
  const skipped: string[] = [];
  let order: Sequence = FIRST_SEQUENCE;
  for (const event of input.events) {
    const wire = toWireMidTurnEvent(event, input.queueOrder);
    const record = cliEventRecord(MID_TURN_CLASSIFY_COMMAND, order, input.occurredAt, wire);
    const encoded = encodeCliRecord(record);
    if (encoded.ok) {
      lines.push(encoded.text);
      order = nextSequence(order);
      continue;
    }
    skipped.push(`${event.kind}: ${encoded.error.code}`);
  }
  const terminal = cliResultRecord(MID_TURN_CLASSIFY_COMMAND, order, input.occurredAt, {
    outcome: input.result.outcome,
    effect: input.result.effect,
    payload: input.result.payload,
    errors: input.result.errors,
    warnings: input.result.warnings,
    omissions: input.result.omissions,
    truncation: input.result.truncation,
    artifacts: input.result.artifacts.map((artifact) => ({ artifactId: artifact.artifactId })),
    correlation: input.result.correlation,
  });
  const encodedTerminal = encodeCliRecord(terminal);
  if (encodedTerminal.ok) {
    lines.push(encodedTerminal.text);
  } else {
    skipped.push(`result: ${encodedTerminal.error.code}`);
  }
  return { lines, skipped };
}

function validationError(message: string, code: string): FalrynError {
  return {
    code,
    category: "configuration",
    message,
    retryable: false,
    effect: "none",
    cause: null,
    correlation: {
      workspaceId: null,
      sessionId: null,
      turnId: null,
      traceId: null,
      scopeId: null,
      invocationId: null,
      capabilityId: null,
      eventId: null,
    },
    recovery: ["retry"],
    exitCategory: "user-error",
    related: [],
    relatedDropped: 0,
    recognized: true,
  };
}

function resultFor(
  payload: MidTurnClassifyPayload | null,
  errors: readonly FalrynError[] = [],
): MidTurnClassifyResult {
  return {
    schemaFamily: COMMAND_RESULT_SCHEMA_FAMILY,
    schemaVersion: COMMAND_RESULT_SCHEMA_VERSION,
    command: MID_TURN_CLASSIFY_COMMAND,
    outcome: errors.length === 0 ? { kind: "completed" } : { kind: "failed", effect: "none" },
    effect: READ_ONLY_EFFECT,
    payload,
    errors,
    warnings: [],
    omissions: [],
    truncation: [],
    artifacts: [],
    correlation: {
      workspaceId: null,
      sessionId: null,
      turnId: null,
      traceId: null,
      scopeId: null,
      invocationId: null,
      capabilityId: null,
      eventId: null,
    },
  };
}

export function runMidTurnClassify(
  arguments_: MidTurnClassifyArguments,
  options?: {
    readonly service?: MidTurnInputService;
  },
): MidTurnClassifyResult {
  const intent = resolveMidTurnIntent(arguments_.intent);
  if (!intent.ok) {
    return resultFor(null, [validationError(intent.reason, "ambiguous-intent")]);
  }

  const service =
    options?.service ??
    createHeadlessMidTurnService({
      ...(arguments_.sessionId === undefined ? {} : { sessionId: arguments_.sessionId }),
      ...(arguments_.followUpId === undefined
        ? {}
        : { nextFollowUpId: () => followUpIdCodec.from(arguments_.followUpId as string) }),
    });

  const request: MidTurnRequestSnapshot = {
    text: arguments_.text,
    attachmentIds: [],
    mentionIds: [],
  };

  const classified = service.classify({
    intent: intent.intent,
    request,
    ...(arguments_.followUpId === undefined
      ? {}
      : { followUpId: followUpIdCodec.from(arguments_.followUpId) }),
  });

  if (!classified.ok) {
    return resultFor(null, [
      validationError(describeMidTurnClassifyError(classified.error), classified.error.code),
    ]);
  }

  const view = service.view();
  const queueOrder = followUpQueueOrder(view);
  const events = classified.events;
  const wireEvents = events.map((event) => toWireMidTurnEvent(event, queueOrder));
  const queuedId =
    classified.classification === "follow-up"
      ? (view.queue.entries.at(-1)?.followUpId ?? null)
      : null;

  return resultFor({
    classification: classified.classification,
    sessionId: view.sessionId,
    followUpId: queuedId,
    queueDepth: view.queue.entries.length,
    queueOrder,
    events: wireEvents,
  });
}

/** Classify then emit JSONL lines (lifecycle mid-turn events + terminal result). */
export function classifyAndRenderJsonl(
  arguments_: MidTurnClassifyArguments,
  options?: {
    readonly service?: MidTurnInputService;
    readonly occurredAt?: Timestamp;
  },
): {
  readonly result: MidTurnClassifyResult;
  readonly lines: readonly string[];
} {
  const service =
    options?.service ??
    createHeadlessMidTurnService({
      ...(arguments_.sessionId === undefined ? {} : { sessionId: arguments_.sessionId }),
      ...(arguments_.followUpId === undefined
        ? {}
        : { nextFollowUpId: () => followUpIdCodec.from(arguments_.followUpId as string) }),
    });
  const result = runMidTurnClassify(arguments_, { service });
  const occurredAt = options?.occurredAt ?? timestampFromEpochMilliseconds(0);
  const events = result.payload === null ? [] : service.events();
  const projected = projectMidTurnEventsToJsonl({
    events,
    queueOrder: result.payload?.queueOrder ?? [],
    occurredAt,
    result,
  });
  return { result, lines: projected.lines };
}
