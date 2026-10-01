import type { ProviderFailure, ProviderFailureKind } from "../../../providers/protocol/errors.ts";
import { anthropicSdk } from "../sdk-runtime.ts";

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
  const sdk = anthropicSdk.loaded();
  if (signal.aborted || (sdk !== undefined && error instanceof sdk.APIUserAbortError)) {
    return failure("cancellation", "The provider request was cancelled.", false);
  }
  if (error instanceof AnthropicInputError) {
    return failure(error.failureKind, error.message, false);
  }
  if (sdk !== undefined && error instanceof sdk.APIConnectionTimeoutError) {
    return failure("timeout", "The provider request timed out.", true);
  }
  if (sdk !== undefined && error instanceof sdk.AuthenticationError) {
    return failure("authentication", "The provider rejected the credentials.", false);
  }
  if (sdk !== undefined && error instanceof sdk.PermissionDeniedError) {
    return failure("authorization", "The provider denied this request.", false);
  }
  if (sdk !== undefined && error instanceof sdk.RateLimitError) {
    return failure(
      "rate-limit",
      "The provider rate-limited this request.",
      true,
      retryAfterMs(error.headers),
    );
  }
  if (
    sdk !== undefined &&
    (error instanceof sdk.BadRequestError || error instanceof sdk.UnprocessableEntityError)
  ) {
    return failure("invalid-request", "The provider rejected the request shape.", false);
  }
  if (sdk !== undefined && error instanceof sdk.InternalServerError) {
    return failure("server-failure", "The provider returned a server failure.", true);
  }
  if (sdk !== undefined && error instanceof sdk.APIConnectionError) {
    return failure("network", "The provider network request failed.", true);
  }
  if (error instanceof SyntaxError) {
    return failure("malformed-stream", "The provider stream contained invalid JSON.", false);
  }
  if (sdk !== undefined && error instanceof sdk.APIError) {
    return failure("server-failure", "The provider returned an unexpected failure.", true);
  }
  return failure("adapter-defect", "The Anthropic SDK adapter failed unexpectedly.", false);
}
