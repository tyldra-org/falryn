import {
  DEFAULT_SESSION_LIST_LIMIT,
  MAX_SESSION_CATALOG,
  SESSION_CATALOG_FILTERS,
  type SessionCatalogFilter,
  type SessionId,
  type StreamId,
  sessionId,
  streamId,
  TERMINAL_OUTCOME_PROJECTION_GENERATION,
  workspaceId,
} from "../../domain/index.ts";

import {
  type RawArguments,
  type RunnableCommand,
  SESSION_REPLAY_ACTIONS,
  type SessionCommandArguments,
  type SessionReplayAction,
} from "./contracts.ts";

export function sessionArgumentsFor(
  command: RunnableCommand,
  parsed: RawArguments,
): SessionCommandArguments | null | string {
  if (
    command !== "session.list" &&
    command !== "session.show" &&
    command !== "session.resume" &&
    command !== "session.fork" &&
    command !== "session.rewind" &&
    command !== "session.replay"
  ) {
    return null;
  }

  const bound = parsed["workspace-id"] ?? "cli";
  const parsedWorkspace = workspaceId.parse(bound);
  if (!parsedWorkspace.ok) {
    return "Argument workspace-id must be a workspace identity.";
  }

  const listOnly =
    (parsed.filter !== undefined && parsed.filter !== "all") ||
    parsed.search !== undefined ||
    parsed.limit !== undefined;
  if (command !== "session.list" && listOnly) {
    return "Arguments filter, search, and limit are only valid with session list.";
  }

  if (command === "session.list") {
    if (parsed.id !== undefined) {
      return "Argument id is only valid with session show, resume, fork, rewind, or replay.";
    }
    const filter = parsed.filter ?? "all";
    if (!(SESSION_CATALOG_FILTERS as readonly string[]).includes(filter)) {
      return "Argument filter must be one of: all, open, closed, pinned.";
    }
    const limit = parsed.limit ?? DEFAULT_SESSION_LIST_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SESSION_CATALOG) {
      return `Argument limit must be a whole number from 1 to ${MAX_SESSION_CATALOG}.`;
    }
    return {
      action: "list",
      workspaceId: parsedWorkspace.value,
      filter: filter as SessionCatalogFilter,
      search: parsed.search,
      limit,
    };
  }

  if (parsed.id === undefined) {
    return `Argument id is required for session ${command.slice("session.".length)}.`;
  }
  const parsedId = sessionId.parse(parsed.id);
  if (!parsedId.ok) {
    return "Argument id must be a session identity.";
  }

  if (command === "session.show") {
    return { action: "show", workspaceId: parsedWorkspace.value, sessionId: parsedId.value };
  }

  if (command === "session.resume") {
    const afterSequence = parsed["after-sequence"] ?? null;
    if (afterSequence !== null && (!Number.isInteger(afterSequence) || afterSequence < 0)) {
      return "Argument after-sequence must be a whole number >= 0.";
    }
    const schemaGeneration = parsed["schema-generation"] ?? TERMINAL_OUTCOME_PROJECTION_GENERATION;
    if (!Number.isInteger(schemaGeneration) || schemaGeneration < 1) {
      return "Argument schema-generation must be a whole number >= 1.";
    }
    return {
      action: "resume",
      workspaceId: parsedWorkspace.value,
      sessionId: parsedId.value,
      afterSequence,
      schemaGeneration,
    };
  }

  if (command === "session.fork" || command === "session.rewind") {
    let newSessionId: SessionId | undefined;
    if (parsed["new-session-id"] !== undefined) {
      const parsedNew = sessionId.parse(parsed["new-session-id"]);
      if (!parsedNew.ok) {
        return "Argument new-session-id must be a session identity.";
      }
      newSessionId = parsedNew.value;
    }
    let newStreamId: StreamId | undefined;
    if (parsed["new-stream-id"] !== undefined) {
      const parsedStream = streamId.parse(parsed["new-stream-id"]);
      if (!parsedStream.ok) {
        return "Argument new-stream-id must be a stream identity.";
      }
      newStreamId = parsedStream.value;
    }
    if (command === "session.fork") {
      if (parsed["at-turn"] !== undefined) {
        return "Argument at-turn is only valid with session rewind.";
      }
      return {
        action: "fork",
        workspaceId: parsedWorkspace.value,
        sessionId: parsedId.value,
        newSessionId,
        newStreamId,
      };
    }
    if (parsed["at-turn"] === undefined || parsed["at-turn"].length === 0) {
      return "Argument at-turn is required for session rewind.";
    }
    return {
      action: "rewind",
      workspaceId: parsedWorkspace.value,
      sessionId: parsedId.value,
      atTurnId: parsed["at-turn"],
      newSessionId,
      newStreamId,
    };
  }

  const replayAction = parsed["replay-action"] ?? "play";
  if (!(SESSION_REPLAY_ACTIONS as readonly string[]).includes(replayAction)) {
    return "Argument replay-action must be one of: play, pause, step, seek.";
  }
  if (replayAction === "seek") {
    const seekSequence = parsed["seek-sequence"];
    if (seekSequence === undefined || !Number.isInteger(seekSequence) || seekSequence < 0) {
      return "Argument seek-sequence is required for replay --replay-action seek.";
    }
    return {
      action: "replay",
      workspaceId: parsedWorkspace.value,
      sessionId: parsedId.value,
      replayCommand: { kind: "seek", sequence: seekSequence },
    };
  }
  return {
    action: "replay",
    workspaceId: parsedWorkspace.value,
    sessionId: parsedId.value,
    replayCommand: { kind: replayAction as Exclude<SessionReplayAction, "seek"> },
  };
}
