/** Strict codec for provider transport compatibility declarations. */

import { z } from "zod";

import { brandedString, toCodecIssues } from "../domain/branded-schema.ts";
import type { CodecIssue } from "../domain/codec-error.ts";
import { modelId } from "../domain/identity.ts";
import { err, ok, type Result } from "../domain/result.ts";
import {
  OPENAI_ASSISTANT_AFTER_TOOL_RESULT_MODES,
  OPENAI_FINISH_REASON_MODES,
  OPENAI_MAX_OUTPUT_TOKEN_FIELDS,
  OPENAI_STREAMING_USAGE_MODES,
  OPENAI_SYSTEM_MESSAGE_ROLES,
  OPENAI_TOOL_RESULT_NAME_MODES,
  PROVIDER_TRANSPORT_COMPATIBILITY_SCHEMA_VERSION,
  PROVIDER_TRANSPORT_COMPATIBILITY_SOURCE_KINDS,
  type ProviderModelTransportCompatibilityOverride,
  type ProviderTransportCompatibilityDeclaration,
} from "./transport-compatibility.ts";

const version = z.literal(PROVIDER_TRANSPORT_COMPATIBILITY_SCHEMA_VERSION);

export const providerTransportCompatibilityDeclarationSchema: z.ZodType<ProviderTransportCompatibilityDeclaration> =
  z.discriminatedUnion("dialect", [
    z
      .strictObject({
        schemaVersion: version,
        dialect: z.literal("openai-chat-completions"),
        systemMessageRole: z.enum(OPENAI_SYSTEM_MESSAGE_ROLES),
        maxOutputTokensField: z.enum(OPENAI_MAX_OUTPUT_TOKEN_FIELDS),
        streamingUsage: z.enum(OPENAI_STREAMING_USAGE_MODES),
        finishReason: z.enum(OPENAI_FINISH_REASON_MODES),
        strictToolSchemas: z.boolean(),
        toolResultName: z.enum(OPENAI_TOOL_RESULT_NAME_MODES),
        assistantAfterToolResult: z.enum(OPENAI_ASSISTANT_AFTER_TOOL_RESULT_MODES),
      })
      .strict(),
    z.strictObject({ schemaVersion: version, dialect: z.literal("anthropic-messages") }),
    z.strictObject({ schemaVersion: version, dialect: z.literal("google-generate-content") }),
    z.strictObject({ schemaVersion: version, dialect: z.literal("command-code-router") }),
    z.strictObject({ schemaVersion: version, dialect: z.literal("deterministic") }),
    z.strictObject({ schemaVersion: version, dialect: z.literal("custom-unavailable") }),
  ]);

function sourceUrlIsAllowed(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username.length === 0 && url.password.length === 0;
  } catch {
    return false;
  }
}

export const providerModelTransportCompatibilityOverrideSchema: z.ZodType<ProviderModelTransportCompatibilityOverride> =
  z
    .strictObject({
      schemaVersion: version,
      modelId: brandedString(modelId),
      declaration: providerTransportCompatibilityDeclarationSchema,
      source: z
        .strictObject({
          kind: z.enum(PROVIDER_TRANSPORT_COMPATIBILITY_SOURCE_KINDS),
          url: z.union([
            z.string().min(1).max(2048).refine(sourceUrlIsAllowed, "invalid source URL"),
            z.null(),
          ]),
          observedAt: z.union([z.string().datetime({ offset: true }), z.null()]),
        })
        .strict(),
    })
    .strict();

export type ProviderTransportCompatibilityDeclarationParseError = {
  readonly kind: "provider-transport-compatibility";
  readonly issues: readonly CodecIssue[];
};

export function parseProviderTransportCompatibilityDeclaration(
  value: unknown,
): Result<
  ProviderTransportCompatibilityDeclaration,
  ProviderTransportCompatibilityDeclarationParseError
> {
  const parsed = providerTransportCompatibilityDeclarationSchema.safeParse(value);
  return parsed.success
    ? ok(parsed.data)
    : err({ kind: "provider-transport-compatibility", issues: toCodecIssues(parsed.error) });
}
