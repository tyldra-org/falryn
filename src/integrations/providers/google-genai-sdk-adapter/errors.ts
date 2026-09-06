import { ApiError } from "@google/genai";
import type { ProviderFailure, ProviderFailureKind } from "../../../providers/protocol/errors.ts";

export class GoogleInputError extends Error {
  readonly failureKind: ProviderFailureKind;

  constructor(failureKind: ProviderFailureKind, message: string) {
    super(message);
    this.name = "GoogleInputError";
    this.failureKind = failureKind;
  }
}

export function failure(
  kind: ProviderFailureKind,
  message: string,
  retryable: boolean,
): ProviderFailure {
  return { kind, message, retryable };
}

export function classifySdkError(error: unknown, signal: AbortSignal): ProviderFailure {
  if (
    signal.aborted ||
    (error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError"))
  ) {
    return error instanceof DOMException && error.name === "TimeoutError" && !signal.aborted
      ? failure("timeout", "The provider request timed out.", true)
      : failure("cancellation", "The provider request was cancelled.", false);
  }
  if (error instanceof GoogleInputError) {
    return failure(error.failureKind, error.message, false);
  }
  if (error instanceof ApiError) {
    if (error.status === 400 || error.status === 409 || error.status === 422) {
      return failure("invalid-request", "The provider rejected the request shape.", false);
    }
    if (error.status === 401) {
      return failure("authentication", "The provider rejected the credentials.", false);
    }
    if (error.status === 403) {
      return failure("authorization", "The provider denied this request.", false);
    }
    if (error.status === 408 || error.status === 504) {
      return failure("timeout", "The provider request timed out.", true);
    }
    if (error.status === 429) {
      return failure("rate-limit", "The provider rate-limited this request.", true);
    }
    if (error.status >= 500) {
      return failure("server-failure", "The provider returned a server failure.", true);
    }
    return failure("invalid-request", "The provider rejected the request.", false);
  }
  if (error instanceof SyntaxError) {
    return failure("malformed-stream", "The provider stream contained invalid JSON.", false);
  }
  if (error instanceof TypeError) {
    return failure("network", "The provider network request failed.", true);
  }
  return failure("adapter-defect", "The Google Gen AI SDK adapter failed unexpectedly.", false);
}
