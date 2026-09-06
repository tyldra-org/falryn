import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from "@anthropic-ai/sdk";
import type { ProviderFailure, ProviderFailureKind } from "../../../providers/protocol/errors.ts";

export class AnthropicInputError extends Error {
  readonly failureKind: ProviderFailureKind;

  constructor(failureKind: ProviderFailureKind, message: string) {
    super(message);
    this.name = "AnthropicInputError";
    this.failureKind = failureKind;
  }
}

export function failure(
  kind: ProviderFailureKind,
  message: string,
  retryable: boolean,
  retryAfterMs?: number,
): ProviderFailure {
  return {
    kind,
    message,
    retryable,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

function retryAfterMs(headers: Headers): number | undefined {
  const millisecondsHeader = headers.get("retry-after-ms");
  const milliseconds = millisecondsHeader === null ? Number.NaN : Number(millisecondsHeader);
  if (Number.isFinite(milliseconds) && milliseconds >= 0) {
    return Math.trunc(milliseconds);
  }
  const secondsHeader = headers.get("retry-after");
  const seconds = secondsHeader === null ? Number.NaN : Number(secondsHeader);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.trunc(seconds * 1_000) : undefined;
}

export function classifySdkError(error: unknown, signal: AbortSignal): ProviderFailure {
  if (signal.aborted || error instanceof APIUserAbortError) {
    return failure("cancellation", "The provider request was cancelled.", false);
  }
  if (error instanceof AnthropicInputError) {
    return failure(error.failureKind, error.message, false);
  }
  if (error instanceof APIConnectionTimeoutError) {
    return failure("timeout", "The provider request timed out.", true);
  }
  if (error instanceof AuthenticationError) {
    return failure("authentication", "The provider rejected the credentials.", false);
  }
  if (error instanceof PermissionDeniedError) {
    return failure("authorization", "The provider denied this request.", false);
  }
  if (error instanceof RateLimitError) {
    return failure(
      "rate-limit",
      "The provider rate-limited this request.",
      true,
      retryAfterMs(error.headers),
    );
  }
  if (error instanceof BadRequestError || error instanceof UnprocessableEntityError) {
    return failure("invalid-request", "The provider rejected the request shape.", false);
  }
  if (error instanceof InternalServerError) {
    return failure("server-failure", "The provider returned a server failure.", true);
  }
  if (error instanceof APIConnectionError) {
    return failure("network", "The provider network request failed.", true);
  }
  if (error instanceof SyntaxError) {
    return failure("malformed-stream", "The provider stream contained invalid JSON.", false);
  }
  if (error instanceof APIError) {
    return failure("server-failure", "The provider returned an unexpected failure.", true);
  }
  return failure("adapter-defect", "The Anthropic SDK adapter failed unexpectedly.", false);
}
