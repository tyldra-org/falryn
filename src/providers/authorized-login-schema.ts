/** Strict codecs for authorized-login descriptors, credentials, and receipts. */

import { z } from "zod";

import { toCodecIssues } from "../domain/branded-schema.ts";
import { instant } from "../domain/clock.ts";
import type { CodecIssue } from "../domain/codec-error.ts";
import { providerId } from "../domain/identity.ts";
import { err, ok, type Result } from "../domain/result.ts";
import { isProviderAdapterKind } from "./adapter-kind.ts";
import {
  AUTHORIZATION_CALLBACK_MODES,
  AUTHORIZATION_RECEIPT_OUTCOMES,
  AUTHORIZED_LOGIN_METHODS,
  AUTHORIZED_LOGIN_SCHEMA_VERSION,
  type AuthorizedProviderCredential,
  type AuthorizedProviderLoginDescriptor,
  MAX_AUTHORIZATION_CODE_LENGTH,
  MAX_AUTHORIZATION_ID_LENGTH,
  MAX_AUTHORIZATION_SCOPE_LENGTH,
  MAX_AUTHORIZATION_SCOPES,
  MAX_AUTHORIZATION_TOKEN_LENGTH,
  MAX_AUTHORIZATION_URL_LENGTH,
  type ProviderAuthorizationReceipt,
} from "./authorized-login.ts";

const id = z.string().min(1).max(MAX_AUTHORIZATION_ID_LENGTH);
const instantSchema = z.number().int().nonnegative().transform(instant);
const scopes = z
  .array(z.string().min(1).max(MAX_AUTHORIZATION_SCOPE_LENGTH))
  .max(MAX_AUTHORIZATION_SCOPES)
  .refine((values) => new Set(values).size === values.length, "duplicate scope");
const loopbackRedirectUri = z
  .string()
  .url()
  .max(MAX_AUTHORIZATION_URL_LENGTH)
  .refine((value) => {
    const parsed = new URL(value);
    return (
      parsed.protocol === "http:" &&
      parsed.hostname === "127.0.0.1" &&
      parsed.port.length > 0 &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.search.length === 0 &&
      parsed.hash.length === 0
    );
  }, "fixed callback must be an exact 127.0.0.1 HTTP URL with an explicit port");

export const authorizedProviderLoginDescriptorSchema = z
  .strictObject({
    schemaVersion: z.literal(AUTHORIZED_LOGIN_SCHEMA_VERSION),
    adapterId: id,
    providerId: id.transform(providerId.from),
    adapterKind: z.string().refine(isProviderAdapterKind, "unknown adapter kind"),
    methods: z
      .array(z.literal(AUTHORIZED_LOGIN_METHODS))
      .min(1)
      .max(AUTHORIZED_LOGIN_METHODS.length)
      .refine((values) => new Set(values).size === values.length, "duplicate method"),
    scopes,
    callbackModes: z
      .array(z.literal(AUTHORIZATION_CALLBACK_MODES))
      .max(AUTHORIZATION_CALLBACK_MODES.length)
      .refine((values) => new Set(values).size === values.length, "duplicate callback mode"),
    loopbackRedirectUri: z.union([loopbackRedirectUri, z.null()]),
    manualRedirectUri: z.union([z.string().url().max(MAX_AUTHORIZATION_URL_LENGTH), z.null()]),
    refresh: z.boolean(),
    revoke: z.boolean(),
    accountLookup: z.boolean(),
    revision: id,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.methods.includes("oauth-pkce") && value.callbackModes.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["callbackModes"],
        message: "PKCE requires a callback mode",
      });
    }
    if (!value.methods.includes("oauth-pkce") && value.callbackModes.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["callbackModes"],
        message: "callback modes require PKCE",
      });
    }
    if (value.callbackModes.includes("manual-code") !== (value.manualRedirectUri !== null)) {
      context.addIssue({
        code: "custom",
        path: ["manualRedirectUri"],
        message: "manual callback mode and redirect must agree",
      });
    }
    if (value.loopbackRedirectUri !== null && !value.callbackModes.includes("loopback")) {
      context.addIssue({
        code: "custom",
        path: ["loopbackRedirectUri"],
        message: "fixed loopback redirect requires loopback callback mode",
      });
    }
  });

export const authorizedProviderCredentialSchema = z
  .strictObject({
    schemaVersion: z.literal(AUTHORIZED_LOGIN_SCHEMA_VERSION),
    kind: z.literal("authorized-provider"),
    accessToken: z.string().min(1).max(MAX_AUTHORIZATION_TOKEN_LENGTH),
    refreshToken: z.union([z.string().min(1).max(MAX_AUTHORIZATION_TOKEN_LENGTH), z.null()]),
    tokenType: z.string().min(1).max(MAX_AUTHORIZATION_CODE_LENGTH),
    scopes,
    issuedAt: instantSchema,
    expiresAt: z.union([instantSchema, z.null()]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.expiresAt !== null && value.expiresAt <= value.issuedAt) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "expiry must follow issuance",
      });
    }
  });

export const providerAuthorizationReceiptSchema = z
  .strictObject({
    schemaVersion: z.literal(AUTHORIZED_LOGIN_SCHEMA_VERSION),
    attemptId: id,
    adapterId: id,
    adapterGeneration: z.number().int().positive(),
    providerId: id,
    profileId: id,
    method: z.literal(AUTHORIZED_LOGIN_METHODS),
    startedAt: instantSchema,
    finishedAt: instantSchema,
    outcome: z.literal(AUTHORIZATION_RECEIPT_OUTCOMES),
    code: z.union([id, z.null()]),
  })
  .strict()
  .refine((value) => value.finishedAt >= value.startedAt, {
    path: ["finishedAt"],
    message: "finish precedes start",
  });

export type AuthorizedLoginParseError = {
  readonly kind: "authorized-login";
  readonly issues: readonly CodecIssue[];
};

function parseWith<Value>(
  schema: z.ZodType<Value>,
  value: unknown,
): Result<Value, AuthorizedLoginParseError> {
  const parsed = schema.safeParse(value);
  return parsed.success
    ? ok(parsed.data)
    : err({ kind: "authorized-login", issues: toCodecIssues(parsed.error) });
}

export function parseAuthorizedProviderLoginDescriptor(
  value: unknown,
): Result<AuthorizedProviderLoginDescriptor, AuthorizedLoginParseError> {
  return parseWith(authorizedProviderLoginDescriptorSchema, value);
}

export function parseAuthorizedProviderCredential(
  value: unknown,
): Result<AuthorizedProviderCredential, AuthorizedLoginParseError> {
  return parseWith(authorizedProviderCredentialSchema, value);
}

export function parseProviderAuthorizationReceipt(
  value: unknown,
): Result<ProviderAuthorizationReceipt, AuthorizedLoginParseError> {
  return parseWith(providerAuthorizationReceiptSchema, value);
}
