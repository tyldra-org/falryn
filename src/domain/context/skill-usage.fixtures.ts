/** Test-only admission receipts for the skill usage read model. */
import {
  configurationGeneration,
  eventId,
  idempotencyKey,
  sequence,
  sessionId,
  streamId,
  traceId,
  turnId,
  workspaceId,
} from "../foundation/index.ts";
import { RUNTIME_EVENT_SCHEMA_VERSION } from "../foundation/limits.ts";
import { timestampFromEpochMilliseconds } from "../foundation/time.ts";
import type { RuntimeEvent } from "../sessions/index.ts";
import type { InstructionSourceReceipt, SkillRouteFact } from "./instruction-source-receipt.ts";
import { PROMPT_TOKEN_ESTIMATOR } from "./prompt-composition.ts";

const hex = (seed: string) =>
  `sha256:${[...seed]
    .map((c) => c.charCodeAt(0).toString(16))
    .join("")
    .padEnd(64, "0")
    .slice(0, 64)}`;

export const usageDigest = hex;

export function skillDecision(
  name: string,
  origin: "project-agents" | "user-agents" | "project-falryn",
  state: "selected" | "shadowed" | "excluded" | "conflicting",
  content = `${name}-${origin}`,
): InstructionSourceReceipt["sources"][number] {
  return {
    identity: {
      version: 1,
      kind: "skill",
      root: hex(origin.startsWith("user") ? "user-root" : "project-root").slice(0, 40),
      path: `${name}/SKILL.md`,
      namespace: "skills",
      localId: name,
    },
    origin,
    scope: "",
    source: hex(`src-${name}-${origin}`),
    digest: hex(content),
    kind: "skill",
    name,
    namespace: "skills",
    state,
    reason: state === "shadowed" ? "lower-priority" : "conventional-skill",
  };
}

export function loadedRoute(
  decision: InstructionSourceReceipt["sources"][number],
  reason = "named-in-task",
  estimates = true,
): SkillRouteFact {
  return {
    name: decision.name,
    decision: "loaded",
    reason,
    source: decision.source,
    digest: decision.digest,
    bytes: 400,
    ...(estimates ? { tokens: 100, listing: { bytes: 30, tokens: 8 } } : {}),
  };
}

export function receiptEvent(input: {
  readonly sequence: number;
  readonly session?: string;
  readonly workspace?: string;
  readonly eventId?: string;
  readonly generation?: string;
  readonly kind?: "main" | "child" | "workflow";
  readonly reused?: boolean;
  readonly omitted?: number;
  readonly at?: number;
  readonly sources: InstructionSourceReceipt["sources"];
  readonly routes?: readonly SkillRouteFact[];
  /** False writes a receipt as it was before estimates were recorded. */
  readonly estimates?: boolean;
}): RuntimeEvent {
  const session = input.session ?? "session-a";
  const estimates = input.estimates ?? true;
  return {
    eventId: eventId.from(input.eventId ?? `event-${session}-${input.sequence}`),
    streamId: streamId.from(`live-turn:${session}`),
    sequence: sequence.from(input.sequence),
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    minimumReaderSchemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    occurredAt: timestampFromEpochMilliseconds(
      input.at ?? Date.UTC(2026, 8, 1, 0, 0, input.sequence),
    ),
    idempotencyKey: idempotencyKey.from(`key-${session}-${input.sequence}`),
    kind: "instructions.resolved",
    correlation: {
      workspaceId: workspaceId.from(input.workspace ?? "workspace-a"),
      sessionId: sessionId.from(session),
      turnId: turnId.from(`turn-${input.sequence}`),
      traceId: traceId.from("trace"),
      configurationGeneration: configurationGeneration.from(0),
    },
    payload: {
      generation: input.generation ?? hex("generation-1"),
      previousGeneration: null,
      configuration: "0",
      workspace: "workspace-a",
      scope: { root: "root", directory: "", execution: "turn", kind: input.kind ?? "main" },
      contentDigest: hex("content"),
      sources: [...input.sources],
      omitted: input.omitted ?? 0,
      reload: "unchanged",
      observedGeneration: null,
      rejection: null,
      contentChanged: false,
      reused: input.reused ?? false,
      ...(input.routes === undefined
        ? {}
        : {
            skills: {
              candidates: input.routes.length,
              routes: [...input.routes],
              ...(estimates
                ? { section: { bytes: 120, tokens: 30 }, estimator: PROMPT_TOKEN_ESTIMATOR }
                : {}),
            },
          }),
    },
  } as RuntimeEvent;
}
