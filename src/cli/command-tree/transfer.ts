/** Export, import, and replay argument normalization. */

import {
  type ExportName,
  exportName,
  parseTimestamp,
  type SessionId,
  sessionId,
} from "../../domain/index.ts";

import type {
  ExportCommandArguments,
  ImportCommandArguments,
  RawArguments,
  ReplayCommandArguments,
  RunnableCommand,
} from "./contracts.ts";

export function exportArgumentsFor(
  command: RunnableCommand,
  parsed: RawArguments,
): ExportCommandArguments | null | string {
  if (command !== "export") {
    return null;
  }

  const sessionValues = parsed.session ?? [];
  const hasSessions = sessionValues.length > 0;
  const hasRange = parsed.after !== undefined || parsed.before !== undefined;
  if (hasSessions && hasRange) {
    return "Arguments session and after/before are mutually exclusive: choose session identities or a time range.";
  }
  if (!hasSessions && !hasRange) {
    return "Export requires --session, or a --after/--before range.";
  }

  const write = parsed.write === true;
  if (write && parsed.name === undefined) {
    return "Argument name is required with --write.";
  }
  if (!write && parsed.name !== undefined) {
    return "Argument name is only valid with --write.";
  }

  let name: ExportName | null = null;
  if (parsed.name !== undefined) {
    const parsedName = exportName.parse(parsed.name);
    if (!parsedName.ok) {
      return "Argument name must be a file-safe export package name.";
    }
    name = parsedName.value;
  }

  const includeSensitive = parsed["include-sensitive"] === true;

  if (hasSessions) {
    const sessionIds: SessionId[] = [];
    for (const value of sessionValues) {
      const parsedId = sessionId.parse(value);
      if (!parsedId.ok) {
        return "Argument session must be a session identity.";
      }
      sessionIds.push(parsedId.value);
    }
    return {
      selection: { kind: "sessions", sessionIds, includeSensitive },
      write,
      name,
    };
  }

  const startedAfter = parsed.after === undefined ? null : parseTimestamp(parsed.after);
  if (startedAfter !== null && !startedAfter.ok) {
    return "Argument after must be a canonical UTC timestamp (YYYY-MM-DDTHH:MM:SS.sssZ).";
  }
  const startedBefore = parsed.before === undefined ? null : parseTimestamp(parsed.before);
  if (startedBefore !== null && !startedBefore.ok) {
    return "Argument before must be a canonical UTC timestamp (YYYY-MM-DDTHH:MM:SS.sssZ).";
  }

  return {
    selection: {
      kind: "range",
      startedAfter: startedAfter === null ? null : startedAfter.value,
      startedBefore: startedBefore === null ? null : startedBefore.value,
      includeSensitive,
    },
    write,
    name,
  };
}

export function importArgumentsFor(
  command: RunnableCommand,
  parsed: RawArguments,
): ImportCommandArguments | null | string {
  if (command !== "import") {
    return null;
  }
  if (
    (parsed.session !== undefined && parsed.session.length > 0) ||
    parsed.after !== undefined ||
    parsed.before !== undefined ||
    parsed.write === true ||
    parsed["include-sensitive"] === true
  ) {
    return "Import accepts only a package name.";
  }
  if (parsed.name === undefined) {
    return "Import requires a package name.";
  }
  const parsedName = exportName.parse(parsed.name);
  if (!parsedName.ok) {
    return "Argument name must be a file-safe export package name.";
  }
  return { name: parsedName.value };
}

export function replayArgumentsFor(
  command: RunnableCommand,
  parsed: RawArguments,
): ReplayCommandArguments | null | string {
  if (command !== "replay") {
    return null;
  }
  if (parsed.id === undefined) {
    return "Argument id is required for replay.";
  }
  const parsedId = sessionId.parse(parsed.id);
  if (!parsedId.ok) {
    return "Argument id must be a session identity.";
  }
  if (parsed["replay-action"] !== undefined && parsed["replay-action"] !== "play") {
    return "Replay does not accept replay control flags; use `falryn session replay` instead.";
  }
  return { sessionId: parsedId.value };
}
