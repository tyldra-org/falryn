/**
 * Application boundary for session export, import, and recovery (#263).
 *
 * Export scope is checked against the session repository. Secret-shaped package
 * or backup names fail closed. Nothing here writes bytes or restores a store.
 */

import {
  err,
  planSessionRecovery,
  type Result,
  type SessionRecoveryError,
  type SessionRecoveryInput,
  type SessionRecoveryPlan,
  type SessionRepositoryPort,
} from "../domain/index.ts";
import { containsRedactableSecret } from "./redaction.ts";

function recoveryError(
  code: SessionRecoveryError["code"],
  field: string | null,
): SessionRecoveryError {
  return { kind: "session-recovery", code, field };
}

function secretInString(value: unknown, field: string): Result<null, SessionRecoveryError> {
  if (typeof value === "string" && containsRedactableSecret(value)) {
    return err(recoveryError("malformed", field));
  }
  return { ok: true, value: null };
}

export type PlanWorkspaceSessionRecoveryInput = SessionRecoveryInput;

export function planWorkspaceSessionRecovery(
  sessions: SessionRepositoryPort,
  input: PlanWorkspaceSessionRecoveryInput,
  signal?: AbortSignal,
): Result<SessionRecoveryPlan, SessionRecoveryError> {
  if (typeof input.packageName === "string") {
    const secret = secretInString(input.packageName, "packageName");
    if (!secret.ok) {
      return secret;
    }
  }
  if (typeof input.name === "string") {
    const secret = secretInString(input.name, "name");
    if (!secret.ok) {
      return secret;
    }
  }
  const planned = planSessionRecovery(input, signal);
  if (!planned.ok) {
    return planned;
  }
  if (planned.value.kind !== "export") {
    return planned;
  }
  for (const sessionIdValue of planned.value.sessionIds) {
    const loaded = sessions.get(sessionIdValue);
    if (!loaded.ok) {
      return err(recoveryError("malformed", "sessions"));
    }
    if (loaded.value === null) {
      return err(recoveryError("not-found", "sessionIds"));
    }
  }
  return planned;
}
