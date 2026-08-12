/**
 * Provider-area identities that are not yet shared domain brands.
 *
 * `ProviderId`, `ModelId`, and `ModelAttemptId` already live in `src/domain/`.
 * A model request is provider-owned until persistence or the agent loop needs
 * it as a cross-area key; until then it stays branded here.
 */

import { MAX_IDENTIFIER_LENGTH } from "../domain/limits.ts";
import { err, ok, type Result } from "../domain/result.ts";

declare const brand: unique symbol;

export type Brand<Value, Name extends string> = Value & { readonly [brand]: Name };

export type ModelRequestId = Brand<string, "ModelRequestId">;

export type ProviderIdentityErrorCode =
  | "identifier-empty"
  | "identifier-too-long"
  | "identifier-illegal-character"
  | "identifier-not-a-string";

export type ProviderIdentityError = {
  readonly kind: "provider-identity";
  readonly code: ProviderIdentityErrorCode;
  readonly identity: string;
};

const LEGAL_IDENTIFIER = /^[!-~]+$/;

function identityError(code: ProviderIdentityErrorCode, identity: string): ProviderIdentityError {
  return { kind: "provider-identity", code, identity };
}

function parseIdentifier(value: unknown, identity: string): Result<string, ProviderIdentityError> {
  if (typeof value !== "string") {
    return err(identityError("identifier-not-a-string", identity));
  }
  if (value.length === 0) {
    return err(identityError("identifier-empty", identity));
  }
  if (value.length > MAX_IDENTIFIER_LENGTH) {
    return err(identityError("identifier-too-long", identity));
  }
  if (!LEGAL_IDENTIFIER.test(value)) {
    return err(identityError("identifier-illegal-character", identity));
  }
  return ok(value);
}

export const modelRequestId = {
  identity: "modelRequestId",
  parse(value: unknown): Result<ModelRequestId, ProviderIdentityError> {
    const parsed = parseIdentifier(value, "modelRequestId");
    if (!parsed.ok) {
      return parsed;
    }
    return ok(parsed.value as ModelRequestId);
  },
  from(value: string): ModelRequestId {
    const parsed = this.parse(value);
    if (!parsed.ok) {
      throw Object.assign(new Error(parsed.error.code), parsed.error);
    }
    return parsed.value;
  },
};
