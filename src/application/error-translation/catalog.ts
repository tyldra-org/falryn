/** Session, artifact, and local-data catalog translations. */

import {
  type ArtifactCatalogError,
  type ArtifactError,
  type ArtifactReadError,
  assertNever,
  type FalrynError,
  type RemovalRefusal,
  recoveryForEffect,
  type SessionCatalogError,
  type SessionIsolationError,
} from "../../domain/index.ts";
import { build, type ErrorContext } from "./shared.ts";

export function fromSessionCatalogError(
  error: SessionCatalogError,
  context: ErrorContext = {},
): FalrynError {
  if (error.code === "cancelled") {
    return build({
      code: "cancellation.session-catalog.cancelled",
      category: "cancellation",
      message: "The session catalog operation was cancelled.",
      retryable: true,
      effect: "none",
      cause: { source: "session-catalog", code: error.code, detail: error.field },
      ...context,
    });
  }
  return build({
    code: `data.session-catalog.${error.code}`,
    category: "data",
    message:
      error.code === "not-found"
        ? "The requested session was not found in the bound workspace."
        : error.code === "secret"
          ? "The session catalog refused secret-shaped input."
          : `The session catalog could not be read (${error.code}).`,
    retryable: false,
    effect: "none",
    recovery: error.code === "not-found" ? ["inspect-state"] : recoveryForEffect("none"),
    cause: { source: "session-catalog", code: error.code, detail: error.field },
    ...context,
  });
}

/** A workspace isolation refusal. */
export function fromSessionIsolationError(
  error: SessionIsolationError,
  context: ErrorContext = {},
): FalrynError {
  if (error.code === "cancelled") {
    return build({
      code: "cancellation.session-isolation.cancelled",
      category: "cancellation",
      message: "Session isolation was cancelled.",
      retryable: true,
      effect: "none",
      cause: { source: "session-isolation", code: error.code, detail: error.field },
      ...context,
    });
  }
  return build({
    code: `data.session-isolation.${error.code}`,
    category: "data",
    message: "Workspace isolation could not be established.",
    retryable: false,
    effect: "none",
    recovery: ["inspect-state"],
    cause: { source: "session-isolation", code: error.code, detail: error.field },
    ...context,
  });
}

/** A bounded artifact catalog refusal. */
export function fromArtifactCatalogError(
  error: ArtifactCatalogError,
  context: ErrorContext = {},
): FalrynError {
  if (error.code === "cancelled") {
    return build({
      code: "cancellation.artifact-catalog.cancelled",
      category: "cancellation",
      message: "The artifact catalog operation was cancelled.",
      retryable: true,
      effect: "none",
      cause: { source: "artifact-catalog", code: error.code, detail: error.field },
      ...context,
    });
  }
  return build({
    code: `data.artifact-catalog.${error.code}`,
    category: "data",
    message:
      error.code === "invalid-limit"
        ? "The artifact list limit is outside the supported range."
        : "The artifact catalog could not be read.",
    retryable: false,
    effect: "none",
    recovery: ["inspect-state"],
    cause: { source: "artifact-catalog", code: error.code, detail: error.field },
    ...context,
  });
}

/** An artifact store or metadata refusal. */
export function fromArtifactError(error: ArtifactError, context: ErrorContext = {}): FalrynError {
  if (error.code === "cancelled") {
    return build({
      code: "cancellation.artifact.cancelled",
      category: "cancellation",
      message: "The artifact operation was cancelled.",
      retryable: true,
      effect: "none",
      cause: { source: "artifact", code: error.code, detail: String(error.artifactId) },
      ...context,
    });
  }
  const artifactId = "artifactId" in error ? String(error.artifactId) : null;
  const message =
    error.code === "not-found"
      ? "The requested artifact was not found."
      : `The artifact could not be read (${error.code}).`;
  return build({
    code: `data.artifact.${error.code}`,
    category: "data",
    message,
    retryable: error.code === "storage",
    effect: "none",
    recovery: error.code === "not-found" ? ["inspect-state"] : recoveryForEffect("none"),
    cause: { source: "artifact", code: error.code, detail: artifactId },
    ...context,
  });
}

/** A bounded artifact read refusal. */
export function fromArtifactReadError(
  error: ArtifactReadError,
  context: ErrorContext = {},
): FalrynError {
  if (!("kind" in error) && error.code === "cancelled") {
    return build({
      code: "cancellation.artifact-read.cancelled",
      category: "cancellation",
      message: "The artifact read was cancelled.",
      retryable: true,
      effect: "none",
      cause: { source: "artifact-read", code: error.code, detail: null },
      ...context,
    });
  }
  if ("kind" in error && error.kind === "artifact") {
    return fromArtifactError(error, context);
  }
  if ("code" in error && error.code === "malformed-request") {
    return build({
      code: "data.artifact-read.malformed-request",
      category: "data",
      message: "The artifact read request was invalid.",
      retryable: false,
      effect: "none",
      cause: { source: "artifact-read", code: error.code, detail: error.field },
      ...context,
    });
  }
  if ("code" in error && error.code === "malformed-limits") {
    return build({
      code: "data.artifact-read.malformed-limits",
      category: "data",
      message: "The artifact read limits were invalid.",
      retryable: false,
      effect: "none",
      cause: { source: "artifact-read", code: error.code, detail: error.field },
      ...context,
    });
  }
  return build({
    code: "data.artifact-read.invalid",
    category: "data",
    message: "The artifact read request was invalid.",
    retryable: false,
    effect: "none",
    cause: { source: "artifact-read", code: "invalid", detail: null },
    ...context,
  });
}

/** A locally planned removal that could not be applied as requested. */
export function fromRemovalRefusal(
  refusal: RemovalRefusal,
  context: ErrorContext = {},
): FalrynError {
  switch (refusal.code) {
    case "plan-mismatch":
      return build({
        code: "data.removal.plan-mismatch",
        category: "data",
        message: "The removal plan changed; preview the current plan before confirming it.",
        retryable: true,
        effect: "none",
        cause: { source: "local-data", code: refusal.code, detail: null },
        ...context,
      });
    case "cancelled":
      return build({
        code: "cancellation.removal.cancelled",
        category: "cancellation",
        message: "The removal was cancelled before it started.",
        retryable: true,
        effect: "none",
        cause: { source: "local-data", code: refusal.code, detail: null },
        ...context,
      });
    default:
      return assertNever(refusal, "unhandled removal refusal");
  }
}

/**
 * Normalizes an unknown throw.
 *
 * `catch` receives `unknown`, and the value is frequently a foreign `Error`
 * whose message was written by a library with no idea what is sensitive. Only
 * the message is taken, and it is redacted; the stack is discarded, because a
 * stack carries absolute paths and sometimes arguments.
 */
