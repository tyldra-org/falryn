/**
 * Workspace and session isolation with stale-source warnings (#262).
 *
 * This is isolation of an already-bound workspace, not add-dir. Sessions from
 * another workspace are omitted. A changed root or Git identity is a warning,
 * not a merge.
 */

import { z } from "zod";

import { brandedString } from "./branded-schema.ts";
import {
  type SessionId,
  sessionId,
  type WorkspaceId,
  workspaceId,
  workspaceRootId,
} from "./identity.ts";
import { assertNever, err, ok, type Result } from "./result.ts";
import { MAX_SESSION_CATALOG } from "./session-catalog.ts";
import type { WorkspaceSet } from "./workspace-set.ts";
import { primaryWorkspaceRoot } from "./workspace-set.ts";

export const SESSION_ISOLATION_VERSION = "session-isolation.v1";
export const SESSION_ISOLATION_SOURCE = "deterministic-workspace-binding";

export const SESSION_ISOLATION_WARNINGS = ["stale-root", "stale-git"] as const;
export type SessionIsolationWarning = (typeof SESSION_ISOLATION_WARNINGS)[number];

export type SessionIsolationErrorCode = "cancelled" | "malformed" | "oversized";

export type SessionIsolationError = {
  readonly kind: "session-isolation";
  readonly code: SessionIsolationErrorCode;
  readonly field: string | null;
};

export type SessionIsolationProvenance = {
  readonly version: typeof SESSION_ISOLATION_VERSION;
  readonly source: typeof SESSION_ISOLATION_SOURCE;
  readonly model: null;
};

export type IsolatedSession = {
  readonly sessionId: SessionId;
  readonly workspaceId: WorkspaceId;
};

export type SessionIsolation = {
  readonly workspaceId: WorkspaceId;
  readonly sessions: readonly IsolatedSession[];
  readonly omitted: number;
  readonly warnings: readonly SessionIsolationWarning[];
  readonly provenance: SessionIsolationProvenance;
};

export type SessionIsolationInput = {
  readonly bound: unknown;
  readonly observed?: unknown;
  readonly sessions?: unknown;
};

/** One resolved root carried on session workspace identity (#604). */
export type WorkspaceRootBinding = {
  readonly rootId: string;
  readonly path: string;
};

const rootBindingSchema = z
  .object({
    rootId: brandedString(workspaceRootId),
    path: z.string().min(1),
  })
  .strict();

const bindingSchema = z
  .object({
    workspaceId: brandedString(workspaceId),
    root: z.string().nullable(),
    gitIdentity: z.string().nullable(),
    /** Optional multi-root set; when present, stale-root compares the full set. */
    roots: z.array(rootBindingSchema).optional(),
  })
  .strict();

function rootsFingerprint(
  roots: readonly { readonly rootId: string; readonly path: string }[] | undefined,
): string | null {
  if (roots === undefined) {
    return null;
  }
  return roots.map((root) => `${root.rootId}\0${root.path}`).join("\n");
}

/**
 * Builds a session workspace binding from a resolved set (#604).
 *
 * `root` stays the primary path so single-root isolation callers keep working.
 */
export function workspaceBindingFromSet(
  workspaceIdValue: WorkspaceId,
  set: WorkspaceSet,
  gitIdentity: string | null,
): {
  readonly workspaceId: WorkspaceId;
  readonly root: string;
  readonly gitIdentity: string | null;
  readonly roots: readonly WorkspaceRootBinding[];
} {
  const primary = primaryWorkspaceRoot(set);
  return {
    workspaceId: workspaceIdValue,
    root: primary.path as string,
    gitIdentity,
    roots: set.roots.map((root) => ({
      rootId: root.rootId as string,
      path: root.path as string,
    })),
  };
}

const sessionSchema = z
  .object({
    sessionId: brandedString(sessionId),
    workspaceId: brandedString(workspaceId),
  })
  .strict();

function isolationError(
  code: SessionIsolationErrorCode,
  field: string | null,
): SessionIsolationError {
  return { kind: "session-isolation", code, field };
}

export function describeSessionIsolationError(error: SessionIsolationError): string {
  const field = error.field === null ? "isolation" : error.field;
  switch (error.code) {
    case "cancelled":
      return `cancelled ${field}`;
    case "malformed":
      return `malformed ${field}`;
    case "oversized":
      return `oversized ${field}`;
    default:
      return assertNever(error.code, "unhandled session-isolation error");
  }
}

/**
 * Keeps sessions of the bound workspace and names stale root or Git identity.
 * Foreign sessions are omitted rather than mixed in.
 */
export function inspectSessionIsolation(
  input: SessionIsolationInput,
  signal?: AbortSignal,
): Result<SessionIsolation, SessionIsolationError> {
  if (signal?.aborted) {
    return err(isolationError("cancelled", "signal"));
  }
  const bound = bindingSchema.safeParse(input.bound);
  if (!bound.success) {
    return err(isolationError("malformed", "bound"));
  }
  let seen = bound.data;
  if (input.observed !== undefined) {
    const observed = bindingSchema.safeParse(input.observed);
    if (!observed.success) {
      return err(isolationError("malformed", "observed"));
    }
    seen = observed.data;
  }
  if (seen.workspaceId !== bound.data.workspaceId) {
    return err(isolationError("malformed", "observed.workspaceId"));
  }
  if (input.sessions !== undefined && !Array.isArray(input.sessions)) {
    return err(isolationError("malformed", "sessions"));
  }
  const raw = input.sessions ?? [];
  if (raw.length > MAX_SESSION_CATALOG) {
    return err(isolationError("oversized", "sessions"));
  }
  const sessions: IsolatedSession[] = [];
  let omitted = 0;
  for (const [index, item] of raw.entries()) {
    const parsed = sessionSchema.safeParse(item);
    if (!parsed.success) {
      return err(isolationError("malformed", `sessions.${index}`));
    }
    if (parsed.data.workspaceId !== bound.data.workspaceId) {
      omitted += 1;
      continue;
    }
    sessions.push(parsed.data);
  }
  const warnings: SessionIsolationWarning[] = [];
  const boundRoots = rootsFingerprint(bound.data.roots);
  const seenRoots = rootsFingerprint(seen.roots);
  if (seen.root !== bound.data.root || boundRoots !== seenRoots) {
    warnings.push("stale-root");
  }
  if (seen.gitIdentity !== bound.data.gitIdentity) {
    warnings.push("stale-git");
  }
  return ok({
    workspaceId: bound.data.workspaceId,
    sessions,
    omitted,
    warnings,
    provenance: {
      version: SESSION_ISOLATION_VERSION,
      source: SESSION_ISOLATION_SOURCE,
      model: null,
    },
  });
}
