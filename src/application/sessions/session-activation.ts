/** One admission boundary for interactive and explicit headless continuation. */
import { randomUUID } from "node:crypto";
import type { ArtifactStorePort } from "../../domain/artifacts/index.ts";
import {
  sessionId,
  streamId,
  traceId,
  turnId,
  type WorkspaceId,
} from "../../domain/foundation/index.ts";
import type {
  EventStorePort,
  SessionRecord,
  SessionRepositoryPort,
  TurnRepositoryPort,
} from "../../domain/sessions/index.ts";
import type { ProductResources } from "../orchestration/product-resources.ts";
import {
  type ConversationHistoryOutcome,
  type ConversationHistoryPorts,
  type ConversationHistorySnapshot,
  createConversationHistoryReader,
} from "./conversation-history.ts";
import { rewindWorkspaceSession } from "./session-rewind.ts";

export type SessionActivationRequest =
  | { readonly kind: "new" }
  | {
      readonly kind: "resume" | "fork" | "rewind";
      readonly sessionId: string;
      readonly observed?: { readonly generation: number; readonly throughSequence: number };
      readonly atTurnId?: string;
    };
export type SessionActivationResult =
  | {
      readonly ok: true;
      readonly sessionId: string;
      readonly streamId: string;
      readonly generation: number;
      readonly explanation: string;
      readonly changed: boolean;
    }
  | { readonly ok: false; readonly code: string; readonly reason: string };
export type SessionActivationFact = {
  readonly kind: "session.activated";
  readonly reason: SessionActivationRequest["kind"];
  readonly sessionId: string;
  readonly streamId: string;
  readonly workspaceId: string;
  readonly generation: number;
  readonly configurationGeneration: number;
  readonly checkpointId: string | null;
  readonly historyDigest: string | null;
};
export type SessionActivationPort = {
  /** Observation only. Late consumers must compare the committed generation. */
  subscribe(listener: (fact: SessionActivationFact) => void): () => void;
  activate(
    request: SessionActivationRequest,
    signal?: AbortSignal,
  ): Promise<SessionActivationResult>;
};
export const activationRefused = (
  code: string,
): Extract<SessionActivationResult, { ok: false }> => ({
  ok: false,
  code,
  reason: `Session activation refused (${code}). The current session and draft are unchanged.`,
});

/** Acquired synchronously, before either prompt admission or asynchronous preparation. */
export function createSessionTransitionGuard() {
  let owner: "prompt" | "activation" | null = null;
  let closed = false;
  return {
    enter(kind: "prompt" | "activation") {
      if (closed || owner !== null) return null;
      owner = kind;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          owner = null;
        }
      };
    },
    close() {
      closed = true;
    },
  };
}
export type PreparedSessionSelection = {
  readonly record: SessionRecord;
  readonly history: ConversationHistorySnapshot;
  readonly parents: NonNullable<ConversationHistoryPorts["parents"]>;
  readonly current: () => boolean;
  readonly explanation: string;
};

/** Capture a committed fork boundary without changing the source stream. */
export async function sessionHistoryBoundary(
  events: EventStorePort,
  source: SessionRecord,
  atTurnId: string | undefined,
  signal?: AbortSignal,
) {
  const head = events.head?.(source.streamId);
  if (!head?.ok) return activationRefused("history-head-unavailable");
  const observedHead = Number(head.value ?? 0);
  if (observedHead > 1000) return activationRefused("history.event-limit");
  if (atTurnId === undefined)
    return { ok: true as const, observedHead, throughSequence: observedHead };
  const page = await events.readFrom(
    { streamId: source.streamId, afterSequence: null },
    1000,
    signal,
  );
  if (!page.ok) return activationRefused("history-unavailable");
  const end = page.value.find(
    (event) => event.kind === "turn.completed" && event.correlation.turnId === atTurnId,
  );
  if (!end) return activationRefused("rewind-boundary-unavailable");
  return { ok: true as const, observedHead, throughSequence: Number(end.sequence) };
}

export async function prepareSessionSelection(
  ports: {
    readonly sessions: SessionRepositoryPort;
    readonly turns: TurnRepositoryPort;
    readonly events: EventStorePort;
    readonly artifacts?: ArtifactStorePort;
    readonly workspaceId: WorkspaceId;
    readonly generation: number;
    readonly resources: ProductResources;
  },
  request: Exclude<SessionActivationRequest, { kind: "new" }>,
  signal: AbortSignal,
): Promise<
  | { readonly ok: true; readonly value: PreparedSessionSelection }
  | ReturnType<typeof activationRefused>
> {
  const parsed = sessionId.parse(request.sessionId);
  if (!parsed.ok) return activationRefused("session-not-found");
  const found = ports.sessions.get(parsed.value);
  if (!found.ok || found.value === null) return activationRefused("session-not-found");
  const source = found.value;
  if (source.workspaceId !== ports.workspaceId) return activationRefused("foreign-workspace");
  const selectedBoundary = await sessionHistoryBoundary(
    ports.events,
    source,
    request.kind === "rewind" ? (request.atTurnId ?? "") : undefined,
    signal,
  );
  if (!selectedBoundary.ok) return selectedBoundary;
  const { observedHead, throughSequence: boundary } = selectedBoundary;
  if (
    request.observed &&
    (request.observed.generation !== Number(source.configurationGeneration) ||
      request.observed.throughSequence !== observedHead)
  )
    return activationRefused("stale-selection");
  if (observedHead === 0 && !source.historyParent) return activationRefused("history-unavailable");
  const parents: NonNullable<ConversationHistoryPorts["parents"]>[number][] = [];
  const records: SessionRecord[] = [source];
  let child = source;
  while (child.historyParent) {
    if (parents.length >= 8) return activationRefused("lineage-limit");
    const parent = ports.sessions.get(child.historyParent.sessionId);
    if (
      !parent.ok ||
      !parent.value ||
      parent.value.workspaceId !== ports.workspaceId ||
      parent.value.streamId !== child.historyParent.streamId ||
      records.some((r) => r.sessionId === parent.value?.sessionId)
    )
      return activationRefused("lineage-unavailable");
    parents.unshift(child.historyParent);
    child = parent.value;
    records.push(child);
  }
  const resources = ports.resources.openTask(String(ports.generation));
  let history: ConversationHistoryOutcome;
  try {
    history = await createConversationHistoryReader({
      events: ports.events,
      ...(ports.artifacts ? { artifacts: ports.artifacts } : {}),
      streamId: source.streamId,
      correlation: {
        workspaceId: ports.workspaceId,
        sessionId: source.sessionId,
        traceId: traceId.from(`activation-${randomUUID()}`),
        configurationGeneration: source.configurationGeneration,
      },
      parents,
      authorize: (_event, artifact) =>
        artifact === null ||
        artifact.sensitivity === "public" ||
        artifact.sensitivity === "user-content",
    }).read(
      { currentTurnId: turnId.from(`activation-${randomUUID()}`), throughSequence: boundary },
      resources,
      signal,
    );
  } finally {
    resources.close();
  }
  if (!history.ok) return activationRefused(`history.${history.code}`);
  const snapshot = history.value;
  if (snapshot.pendingOperations.length) return activationRefused("unfinished-operations");
  const current = () => {
    const now = ports.events.head?.(source.streamId);
    return (
      !signal.aborted &&
      now?.ok === true &&
      Number(now.value ?? 0) === observedHead &&
      snapshot.current() &&
      records.every((r) => {
        const live = ports.sessions.get(r.sessionId);
        return live.ok && JSON.stringify(live.value) === JSON.stringify(r);
      })
    );
  };
  if (!current()) return activationRefused("stale-selection");
  let record = source;
  if (request.kind !== "resume") {
    if (parents.length >= 8) return activationRefused("lineage-limit");
    const suffix = randomUUID();
    const forked = rewindWorkspaceSession(
      ports.sessions,
      ports.turns,
      {
        sourceSessionId: source.sessionId,
        identities: {
          sessionId: sessionId.from(`${request.kind}-${suffix}`),
          streamId: streamId.from(`stream-${request.kind}-${suffix}`),
          workspaceId: ports.workspaceId,
        },
        throughSequence: boundary,
        edit:
          request.kind === "rewind"
            ? { kind: "rewind", atTurnId: request.atTurnId ?? "" }
            : { kind: "fork" },
      },
      signal,
    );
    if (!forked.ok) return activationRefused(forked.error.code);
    const stored = ports.sessions.get(forked.value.sessionId);
    if (!stored.ok || !stored.value) return activationRefused("fork-record-unavailable");
    record = stored.value;
    parents.push({
      sessionId: source.sessionId,
      streamId: source.streamId,
      throughSequence: boundary,
    });
  }
  const lastInput =
    snapshot.records
      .findLast((r) => r.event.payload.type === "message" && r.event.payload.role === "user")
      ?.text.slice(0, 160)
      .replace(/\p{C}/gu, " ") ?? "none";
  const explanation = `Session ${record.sessionId}; history ${source.sessionId} through ${boundary}; checkpoint ${snapshot.checkpointId ?? "none"}; current configuration ${ports.generation} (recorded ${source.configurationGeneration}). Current instructions, model and permissions apply. Accepted input: ${lastInput}. Unresolved operations: ${snapshot.pendingOperations.length}. ${snapshot.omissions.length} retained history notices (${
    snapshot.omissions
      .slice(0, 4)
      .map((item) => item.reason)
      .join(", ") || "none"
  }); current task queues require inspection. No historical effects are replayed.`;
  return { ok: true, value: { record, history: snapshot, parents, current, explanation } };
}
