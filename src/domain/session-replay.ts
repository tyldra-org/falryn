/**
 * Import and effect-free replay of a verified export package.
 *
 * An export is a portable claim. This module is what makes that claim local
 * again without re-running the work that produced it. Four rules the types
 * carry rather than document:
 *
 * - **Verify first, then import.** A package that failed its member hashes is
 *   refused rather than partially applied. Silence here would put unverified
 *   bytes into canonical history.
 * - **Identity collisions are refused, never merged by title.** Two sessions
 *   with the same id are the same session; two sessions with the same title
 *   are not. A colliding identity is a reported fact, not a merge.
 * - **Replay rebuilds views from recorded facts.** It never names a command
 *   runner, a provider, or a network. Inherited evidence stays historical.
 * - **A fork is a new lineage.** It inserts a new session under new identities
 *   and a fresh configuration generation. The original stream is not
 *   truncated, rewritten, or replayed as live work.
 */

import { z } from "zod";
import { type ArtifactError, type ArtifactRecord, parseArtifactRecord } from "./artifact.ts";
import { decodeRuntimeEvent } from "./codec.ts";
import type { CodecIssue } from "./codec-error.ts";
import type { RuntimeEvent } from "./event.ts";
import type { EventStoreError } from "./event-store.ts";
import type { ExportError } from "./export.ts";
import type { SessionId, StreamId, TurnId, WorkspaceId } from "./identity.ts";
import {
  type InvocationRecord,
  type ModelAttemptRecord,
  parseInvocationRecord,
  parseModelAttemptRecord,
  parseSessionRecord,
  parseTurnRecord,
  type RecordError,
  type SessionRecord,
  type TurnRecord,
} from "./records.ts";
import { err, ok, type Result } from "./result.ts";
import type { ReplayReport } from "./sequence.ts";
import type { ReplayedTurn } from "./turn-events.ts";

/** Importers keep the identities the package declared, or they refuse. */
export const IMPORT_IDENTITY_POLICIES = ["preserve"] as const;
export type ImportIdentityPolicy = (typeof IMPORT_IDENTITY_POLICIES)[number];

/** Entities a records member may name. */
export const EXPORT_RECORD_ENTITIES = [
  "session",
  "turn",
  "model-attempt",
  "invocation",
  "event",
  "artifact",
] as const;
export type ExportRecordEntity = (typeof EXPORT_RECORD_ENTITIES)[number];

export type ExportRecordLine =
  | { readonly entity: "session"; readonly record: SessionRecord }
  | { readonly entity: "turn"; readonly record: TurnRecord }
  | { readonly entity: "model-attempt"; readonly record: ModelAttemptRecord }
  | { readonly entity: "invocation"; readonly record: InvocationRecord }
  | { readonly entity: "event"; readonly record: RuntimeEvent }
  | { readonly entity: "artifact"; readonly record: ArtifactRecord };

export type ImportError =
  | { readonly kind: "import"; readonly code: "unverified-package" }
  | {
      readonly kind: "import";
      readonly code: "malformed-record";
      readonly issues: readonly CodecIssue[];
    }
  | {
      readonly kind: "import";
      readonly code: "identity-collision";
      readonly entity: ExportRecordEntity;
      readonly identity: string;
    }
  | { readonly kind: "import"; readonly code: "empty-package" }
  | { readonly kind: "import"; readonly code: "cancelled" }
  | { readonly kind: "import"; readonly code: "export"; readonly error: ExportError }
  | { readonly kind: "import"; readonly code: "record"; readonly error: RecordError }
  | { readonly kind: "import"; readonly code: "artifact"; readonly error: ArtifactError }
  | { readonly kind: "import"; readonly code: "events"; readonly error: EventStoreError };

export type ImportResult = {
  readonly sessionIds: readonly SessionId[];
  readonly events: number;
  readonly artifacts: number;
};

export type SessionReplay = {
  readonly sessionId: SessionId;
  readonly streamId: StreamId;
  readonly turns: readonly ReplayedTurn[];
  readonly artifacts: readonly ArtifactRecord[];
  readonly report: ReplayReport;
  readonly truncated: boolean;
};

export type SessionFork = {
  readonly sessionId: SessionId;
  readonly sourceSessionId: SessionId;
  readonly streamId: StreamId;
  readonly workspaceId: WorkspaceId;
  readonly parentTurnId: TurnId | null;
};

const lineSchema = z.object({
  entity: z.enum(EXPORT_RECORD_ENTITIES),
  record: z.unknown(),
});

function prefixIssues(path: string, issues: readonly CodecIssue[]): readonly CodecIssue[] {
  return issues.map((issue) => ({
    path: issue.path.length > 0 ? `${path}.${issue.path}` : path,
    code: issue.code,
  }));
}

/**
 * Parses one JSONL object from a records member.
 *
 * The entity tag decides which record parser runs, so a hostile line cannot
 * place a session where an event belongs.
 */
export function parseExportRecordLine(
  value: unknown,
): Result<ExportRecordLine, readonly CodecIssue[]> {
  const tagged = lineSchema.safeParse(value);
  if (!tagged.success) {
    return err(
      tagged.error.issues.map((issue) => ({
        path: issue.path.map((segment) => String(segment)).join("."),
        code: issue.code,
      })),
    );
  }
  switch (tagged.data.entity) {
    case "session": {
      const parsed = parseSessionRecord(tagged.data.record);
      return parsed.ok
        ? ok({ entity: "session", record: parsed.value })
        : err(prefixIssues("record", parsed.error));
    }
    case "turn": {
      const parsed = parseTurnRecord(tagged.data.record);
      return parsed.ok
        ? ok({ entity: "turn", record: parsed.value })
        : err(prefixIssues("record", parsed.error));
    }
    case "model-attempt": {
      const parsed = parseModelAttemptRecord(tagged.data.record);
      return parsed.ok
        ? ok({ entity: "model-attempt", record: parsed.value })
        : err(prefixIssues("record", parsed.error));
    }
    case "invocation": {
      const parsed = parseInvocationRecord(tagged.data.record);
      return parsed.ok
        ? ok({ entity: "invocation", record: parsed.value })
        : err(prefixIssues("record", parsed.error));
    }
    case "event": {
      const parsed = decodeRuntimeEvent(JSON.stringify(tagged.data.record));
      if (!parsed.ok) {
        return err([{ path: "record", code: parsed.error.kind }]);
      }
      return ok({ entity: "event", record: parsed.value });
    }
    case "artifact": {
      const parsed = parseArtifactRecord(tagged.data.record);
      return parsed.ok
        ? ok({ entity: "artifact", record: parsed.value })
        : err(prefixIssues("record", parsed.error));
    }
    default: {
      const _exhaustive: never = tagged.data.entity;
      return _exhaustive;
    }
  }
}
