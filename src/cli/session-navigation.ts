/**
 * Session resume / fork / rewind / replay CLI (#721).
 *
 * Product commands over the #259–#261 application ports. Replay is cursor-only
 * and never repeats tool or provider effects.
 */

import {
  controlWorkspaceSessionReplay,
  fromUnknown,
  resumeWorkspaceSession,
  rewindWorkspaceSession,
} from "../application/index.ts";
import {
  createRecordRepositories,
  createSqliteEventStore,
  openSqliteStore,
  PRODUCTION_MIGRATIONS,
  probeStorage,
  rootChild,
  sqliteDatabasePath,
} from "../data/index.ts";
import {
  blocksLocalData,
  DEFAULT_BUSY_TIMEOUT_MS,
  type FalrynError,
  type Sequence,
  type SqliteStorePort,
  sessionId,
  streamId,
  type TerminalOutcome,
} from "../domain/index.ts";
import { openBunSqlite } from "../integrations/index.ts";
import type { SessionCommandArguments } from "./command-tree.ts";
import {
  COMMAND_RESULT_SCHEMA_FAMILY,
  COMMAND_RESULT_SCHEMA_VERSION,
  type CommandEffect,
  type CommandId,
  type CommandResultOf,
  READ_ONLY_EFFECT,
} from "./result.ts";
import type { ServiceProvider } from "./services.ts";

export const SESSION_NAVIGATION_OWNER = "#721";

const WRITE_COMPLETED_EFFECT: CommandEffect = { intent: "mutate", observed: "completed" };

export type SessionResumePayload = {
  readonly owner: typeof SESSION_NAVIGATION_OWNER;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly streamId: string;
  readonly afterSequence: number | null;
  readonly pending: number;
};

export type SessionForkPayload = {
  readonly owner: typeof SESSION_NAVIGATION_OWNER;
  readonly sourceSessionId: string;
  readonly sessionId: string;
  readonly streamId: string;
  readonly workspaceId: string;
  readonly kind: "fork" | "rewind";
  readonly atTurnId: string | null;
};

export type SessionReplayPayload = {
  readonly owner: typeof SESSION_NAVIGATION_OWNER;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly status: string;
  readonly atSequence: number | null;
  readonly applied: number;
  readonly effectFree: true;
};

type Opened =
  | { readonly ok: true; readonly kind: "absent" }
  | { readonly ok: true; readonly kind: "open"; readonly store: SqliteStorePort }
  | { readonly ok: false; readonly errors: readonly FalrynError[] };

function resultFor<Command extends CommandId, Payload>(
  command: Command,
  payload: Payload | null,
  errors: readonly FalrynError[] = [],
  effect: CommandEffect = READ_ONLY_EFFECT,
  outcome?: TerminalOutcome,
): CommandResultOf<Command, Payload> {
  return {
    schemaFamily: COMMAND_RESULT_SCHEMA_FAMILY,
    schemaVersion: COMMAND_RESULT_SCHEMA_VERSION,
    command,
    outcome:
      outcome ?? (errors.length === 0 ? { kind: "completed" } : { kind: "failed", effect: "none" }),
    effect,
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

async function openStore(
  services: ServiceProvider,
  signal: AbortSignal | undefined,
): Promise<Opened> {
  const { localData, clock } = services();
  const inspections = await localData.inspectRoots();
  const state = inspections.find((inspection) => inspection.root === "state");
  if (state !== undefined && blocksLocalData(state)) {
    return {
      ok: false,
      errors: [
        fromUnknown(new Error("the state root is unusable"), { operation: "inspect state root" }),
      ],
    };
  }
  const stateRoot = rootChild(localData.layout, "state");
  const databasePath = stateRoot === null ? null : sqliteDatabasePath(stateRoot);
  if (stateRoot === null || databasePath === null) {
    return {
      ok: false,
      errors: [
        fromUnknown(new Error("a state root could not be resolved"), {
          operation: "resolve session store",
        }),
      ],
    };
  }
  const probe = await probeStorage({ open: openBunSqlite, databasePath });
  if (probe.kind === "absent") {
    return { ok: true, kind: "absent" };
  }
  if (probe.kind !== "present") {
    return {
      ok: false,
      errors: [
        fromUnknown(new Error("the local database could not be read"), {
          operation: "probe session store",
        }),
      ],
    };
  }
  const opened = await openSqliteStore(
    {
      open: openBunSqlite,
      clock,
      databasePath,
      backupDirectory: stateRoot,
      migrations: PRODUCTION_MIGRATIONS,
      busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
      create: false,
    },
    signal,
  );
  if (!opened.ok) {
    return {
      ok: false,
      errors: [
        fromUnknown(new Error("the local database could not be opened"), {
          operation: "open local database",
        }),
      ],
    };
  }
  return { ok: true, kind: "open", store: opened.value };
}

function absentError(operation: string): FalrynError {
  return fromUnknown(new Error("no local session store is present"), { operation });
}

function navigationFailure(code: string, operation: string): FalrynError {
  return fromUnknown(new Error(`session navigation failed (${code})`), { operation });
}

/** Resume a session from a durable cursor without appending or forking. */
export async function runSessionResume(
  services: ServiceProvider,
  arguments_: Extract<SessionCommandArguments, { action: "resume" }>,
  signal?: AbortSignal,
): Promise<CommandResultOf<"session.resume", SessionResumePayload>> {
  try {
    const opened = await openStore(services, signal);
    if (!opened.ok) {
      return resultFor("session.resume", null, opened.errors);
    }
    if (opened.kind === "absent") {
      return resultFor("session.resume", null, [absentError("resume session")]);
    }
    const repositories = createRecordRepositories(opened.store);
    const events = createSqliteEventStore(opened.store);
    const resumed = await resumeWorkspaceSession(
      repositories.sessions,
      events,
      {
        sessionId: arguments_.sessionId,
        cursor:
          arguments_.afterSequence === null
            ? null
            : {
                afterSequence: arguments_.afterSequence as Sequence,
                schemaGeneration: arguments_.schemaGeneration,
              },
      },
      signal,
    );
    if (!resumed.ok) {
      return resultFor("session.resume", null, [
        navigationFailure(resumed.error.code, "resume session"),
      ]);
    }
    return resultFor("session.resume", {
      owner: SESSION_NAVIGATION_OWNER,
      sessionId: String(resumed.value.sessionId),
      workspaceId: String(arguments_.workspaceId),
      streamId: String(resumed.value.streamId),
      afterSequence:
        resumed.value.cursor.afterSequence === null
          ? null
          : Number(resumed.value.cursor.afterSequence),
      pending: resumed.value.pending,
    });
  } catch (error) {
    return resultFor("session.resume", null, [fromUnknown(error, { operation: "resume session" })]);
  }
}

/** Fork or rewind a session into new identities (source history untouched). */
export async function runSessionForkOrRewind(
  services: ServiceProvider,
  arguments_: Extract<SessionCommandArguments, { action: "fork" | "rewind" }>,
  signal?: AbortSignal,
): Promise<
  | CommandResultOf<"session.fork", SessionForkPayload>
  | CommandResultOf<"session.rewind", SessionForkPayload>
> {
  const command =
    arguments_.action === "fork" ? ("session.fork" as const) : ("session.rewind" as const);
  try {
    const opened = await openStore(services, signal);
    if (!opened.ok) {
      return resultFor(command, null, opened.errors);
    }
    if (opened.kind === "absent") {
      return resultFor(command, null, [absentError(`${arguments_.action} session`)]);
    }
    const repositories = createRecordRepositories(opened.store);
    const suffix = crypto.randomUUID();
    const newSessionId =
      arguments_.newSessionId ?? sessionId.from(`${arguments_.action}-${suffix}`);
    const newStreamId =
      arguments_.newStreamId ?? streamId.from(`stream-${arguments_.action}-${suffix}`);
    const planned = rewindWorkspaceSession(
      repositories.sessions,
      repositories.turns,
      {
        sourceSessionId: arguments_.sessionId,
        identities: {
          sessionId: newSessionId,
          streamId: newStreamId,
          workspaceId: arguments_.workspaceId,
        },
        edit:
          arguments_.action === "fork"
            ? { kind: "fork" }
            : { kind: "rewind", atTurnId: arguments_.atTurnId },
      },
      signal,
    );
    if (!planned.ok) {
      return resultFor(command, null, [
        navigationFailure(planned.error.code, `${arguments_.action} session`),
      ]);
    }
    return resultFor(
      command,
      {
        owner: SESSION_NAVIGATION_OWNER,
        sourceSessionId: String(arguments_.sessionId),
        sessionId: String(planned.value.sessionId),
        streamId: String(planned.value.streamId),
        workspaceId: String(arguments_.workspaceId),
        kind: arguments_.action === "fork" ? "fork" : "rewind",
        atTurnId: arguments_.action === "rewind" ? arguments_.atTurnId : null,
      },
      [],
      WRITE_COMPLETED_EFFECT,
    );
  } catch (error) {
    return resultFor(command, null, [
      fromUnknown(error, { operation: `${arguments_.action} session` }),
    ]);
  }
}

/** Move a replay cursor over recorded events without repeating effects. */
export async function runSessionReplay(
  services: ServiceProvider,
  arguments_: Extract<SessionCommandArguments, { action: "replay" }>,
  signal?: AbortSignal,
): Promise<CommandResultOf<"session.replay", SessionReplayPayload>> {
  try {
    const opened = await openStore(services, signal);
    if (!opened.ok) {
      return resultFor("session.replay", null, opened.errors);
    }
    if (opened.kind === "absent") {
      return resultFor("session.replay", null, [absentError("replay session")]);
    }
    const repositories = createRecordRepositories(opened.store);
    const events = createSqliteEventStore(opened.store);
    const controlled = await controlWorkspaceSessionReplay(
      repositories.sessions,
      events,
      {
        sessionId: arguments_.sessionId,
        command: arguments_.replayCommand,
      },
      signal,
    );
    if (!controlled.ok) {
      return resultFor("session.replay", null, [
        navigationFailure(controlled.error.code, "replay session"),
      ]);
    }
    return resultFor("session.replay", {
      owner: SESSION_NAVIGATION_OWNER,
      sessionId: String(arguments_.sessionId),
      workspaceId: String(arguments_.workspaceId),
      status: controlled.value.status,
      atSequence: controlled.value.atSequence === null ? null : Number(controlled.value.atSequence),
      applied: controlled.value.applied,
      effectFree: true,
    });
  } catch (error) {
    return resultFor("session.replay", null, [fromUnknown(error, { operation: "replay session" })]);
  }
}
