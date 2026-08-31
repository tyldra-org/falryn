/** Strict codec for provider transport compatibility declarations. */

import { z } from "zod";

import { brandedString, toCodecIssues } from "../domain/branded-schema.ts";
import type { CodecIssue } from "../domain/codec-error.ts";
import { modelId } from "../domain/identity.ts";
import { err, ok, type Result } from "../domain/result.ts";
import {
  ANTHROPIC_API_VERSION_MODES,
  ANTHROPIC_BETA_HEADER_MODES,
  ANTHROPIC_INPUT_ENCODINGS,
  ANTHROPIC_MAX_OUTPUT_TOKEN_FIELDS,
  ANTHROPIC_MESSAGES_TRANSPORT_DEFAULT,
  ANTHROPIC_PROMPT_CACHE_PLACEMENTS,
  ANTHROPIC_PROMPT_CACHE_TTLS,
  ANTHROPIC_SERVICE_TIERS,
  ANTHROPIC_STREAMING_USAGE_MODES,
  ANTHROPIC_STRUCTURED_OUTPUT_MODES,
  ANTHROPIC_SYSTEM_PROMPT_MODES,
  ANTHROPIC_THINKING_MODES,
  ANTHROPIC_THINKING_REPLAY_MODES,
  ANTHROPIC_TOOL_RESULT_ORDERINGS,
  GOOGLE_API_VERSION_MODES,
  GOOGLE_FUNCTION_CALL_IDENTITIES,
  GOOGLE_FUNCTION_RESPONSE_ORDERINGS,
  GOOGLE_GENERATE_CONTENT_TRANSPORT_DEFAULT,
  GOOGLE_INPUT_ENCODINGS,
  GOOGLE_MAX_OUTPUT_TOKEN_FIELDS,
  GOOGLE_PROMPT_CACHE_BINDINGS,
  GOOGLE_ROLE_MAPPINGS,
  GOOGLE_SAFETY_MODES,
  GOOGLE_STREAMING_MODES,
  GOOGLE_STRUCTURED_OUTPUT_MODES,
  GOOGLE_SYSTEM_INSTRUCTION_MODES,
  GOOGLE_THINKING_MODES,
  GOOGLE_THINKING_REPLAY_MODES,
  GOOGLE_USAGE_MODES,
  OPENAI_ASSISTANT_AFTER_TOOL_RESULT_MODES,
  OPENAI_FINISH_REASON_MODES,
  OPENAI_MAX_OUTPUT_TOKEN_FIELDS,
  OPENAI_RESPONSES_CONTINUATION_MODES,
  OPENAI_RESPONSES_PROMPT_CACHE_TTLS,
  OPENAI_RESPONSES_REASONING_SUMMARIES,
  OPENAI_RESPONSES_SERVICE_TIERS,
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
    z
      .strictObject({
        schemaVersion: version,
        dialect: z.literal("openai-responses"),
        systemMessageRole: z.enum(OPENAI_SYSTEM_MESSAGE_ROLES),
        continuation: z.enum(OPENAI_RESPONSES_CONTINUATION_MODES),
        store: z.boolean(),
        includeEncryptedReasoning: z.boolean(),
        reasoningSummary: z.enum(OPENAI_RESPONSES_REASONING_SUMMARIES),
        promptCacheTtl: z.enum(OPENAI_RESPONSES_PROMPT_CACHE_TTLS),
        sessionAffinity: z.literal("prompt-cache-key"),
        serviceTier: z.enum(OPENAI_RESPONSES_SERVICE_TIERS),
        streamObfuscation: z.boolean(),
        strictToolSchemas: z.boolean(),
        parallelToolCalls: z.boolean(),
      })
      .strict()
      .superRefine((declaration, context) => {
        if (declaration.continuation === "previous-response" && !declaration.store) {
          context.addIssue({
            code: "custom",
            path: ["store"],
            message: "previous-response continuation requires provider storage",
          });
        }
        if (declaration.continuation === "stateless" && declaration.store) {
          context.addIssue({
            code: "custom",
            path: ["store"],
            message: "stateless continuation cannot enable provider storage",
          });
        }
        if (declaration.continuation === "stateless" && !declaration.includeEncryptedReasoning) {
          context.addIssue({
            code: "custom",
            path: ["includeEncryptedReasoning"],
            message: "stateless continuation must retain encrypted reasoning",
          });
        }
      }),
    z
      .strictObject({
        schemaVersion: version,
        dialect: z.literal("anthropic-messages"),
        systemPrompt: z
          .enum(ANTHROPIC_SYSTEM_PROMPT_MODES)
          .default(ANTHROPIC_MESSAGES_TRANSPORT_DEFAULT.systemPrompt),
        maxOutputTokensField: z
          .enum(ANTHROPIC_MAX_OUTPUT_TOKEN_FIELDS)
          .default(ANTHROPIC_MESSAGES_TRANSPORT_DEFAULT.maxOutputTokensField),
        thinking: z
          .enum(ANTHROPIC_THINKING_MODES)
          .default(ANTHROPIC_MESSAGES_TRANSPORT_DEFAULT.thinking),
        thinkingReplay: z
          .enum(ANTHROPIC_THINKING_REPLAY_MODES)
          .default(ANTHROPIC_MESSAGES_TRANSPORT_DEFAULT.thinkingReplay),
        structuredOutput: z
          .enum(ANTHROPIC_STRUCTURED_OUTPUT_MODES)
          .default(ANTHROPIC_MESSAGES_TRANSPORT_DEFAULT.structuredOutput),
        promptCachePlacement: z
          .enum(ANTHROPIC_PROMPT_CACHE_PLACEMENTS)
          .default(ANTHROPIC_MESSAGES_TRANSPORT_DEFAULT.promptCachePlacement),
        promptCacheTtl: z
          .union([z.enum(ANTHROPIC_PROMPT_CACHE_TTLS), z.null()])
          .default(ANTHROPIC_MESSAGES_TRANSPORT_DEFAULT.promptCacheTtl),
        toolResultOrdering: z
          .enum(ANTHROPIC_TOOL_RESULT_ORDERINGS)
          .default(ANTHROPIC_MESSAGES_TRANSPORT_DEFAULT.toolResultOrdering),
        strictToolSchemas: z
          .boolean()
          .default(ANTHROPIC_MESSAGES_TRANSPORT_DEFAULT.strictToolSchemas),
        streamingUsage: z
          .enum(ANTHROPIC_STREAMING_USAGE_MODES)
          .default(ANTHROPIC_MESSAGES_TRANSPORT_DEFAULT.streamingUsage),
        serviceTier: z
          .enum(ANTHROPIC_SERVICE_TIERS)
          .default(ANTHROPIC_MESSAGES_TRANSPORT_DEFAULT.serviceTier),
        apiVersion: z
          .enum(ANTHROPIC_API_VERSION_MODES)
          .default(ANTHROPIC_MESSAGES_TRANSPORT_DEFAULT.apiVersion),
        betaHeaders: z
          .enum(ANTHROPIC_BETA_HEADER_MODES)
          .default(ANTHROPIC_MESSAGES_TRANSPORT_DEFAULT.betaHeaders),
        inputEncoding: z
          .enum(ANTHROPIC_INPUT_ENCODINGS)
          .default(ANTHROPIC_MESSAGES_TRANSPORT_DEFAULT.inputEncoding),
      })
      .strict()
      .superRefine((declaration, context) => {
        if (declaration.thinking === "adaptive" && declaration.thinkingReplay !== "signed-blocks") {
          context.addIssue({
            code: "custom",
            path: ["thinkingReplay"],
            message: "adaptive thinking requires signed-block replay",
          });
        }
        if (
          declaration.promptCachePlacement === "system-prefix" &&
          declaration.promptCacheTtl === null
        ) {
          context.addIssue({
            code: "custom",
            path: ["promptCacheTtl"],
            message: "system-prefix prompt caching requires a TTL",
          });
        }
        if (declaration.promptCachePlacement === "none" && declaration.promptCacheTtl !== null) {
          context.addIssue({
            code: "custom",
            path: ["promptCacheTtl"],
            message: "a disabled prompt cache cannot declare a TTL",
          });
        }
      }),
    z
      .strictObject({
        schemaVersion: version,
        dialect: z.literal("google-generate-content"),
        systemInstruction: z
          .enum(GOOGLE_SYSTEM_INSTRUCTION_MODES)
          .default(GOOGLE_GENERATE_CONTENT_TRANSPORT_DEFAULT.systemInstruction),
        roleMapping: z
          .enum(GOOGLE_ROLE_MAPPINGS)
          .default(GOOGLE_GENERATE_CONTENT_TRANSPORT_DEFAULT.roleMapping),
        maxOutputTokensField: z
          .enum(GOOGLE_MAX_OUTPUT_TOKEN_FIELDS)
          .default(GOOGLE_GENERATE_CONTENT_TRANSPORT_DEFAULT.maxOutputTokensField),
        thinking: z
          .enum(GOOGLE_THINKING_MODES)
          .default(GOOGLE_GENERATE_CONTENT_TRANSPORT_DEFAULT.thinking),
        thinkingReplay: z
          .enum(GOOGLE_THINKING_REPLAY_MODES)
          .default(GOOGLE_GENERATE_CONTENT_TRANSPORT_DEFAULT.thinkingReplay),
        structuredOutput: z
          .enum(GOOGLE_STRUCTURED_OUTPUT_MODES)
          .default(GOOGLE_GENERATE_CONTENT_TRANSPORT_DEFAULT.structuredOutput),
        functionCallIdentity: z
          .enum(GOOGLE_FUNCTION_CALL_IDENTITIES)
          .default(GOOGLE_GENERATE_CONTENT_TRANSPORT_DEFAULT.functionCallIdentity),
        functionResponseOrdering: z
          .enum(GOOGLE_FUNCTION_RESPONSE_ORDERINGS)
          .default(GOOGLE_GENERATE_CONTENT_TRANSPORT_DEFAULT.functionResponseOrdering),
        promptCacheBinding: z
          .enum(GOOGLE_PROMPT_CACHE_BINDINGS)
          .default(GOOGLE_GENERATE_CONTENT_TRANSPORT_DEFAULT.promptCacheBinding),
        safety: z
          .enum(GOOGLE_SAFETY_MODES)
          .default(GOOGLE_GENERATE_CONTENT_TRANSPORT_DEFAULT.safety),
        streaming: z
          .enum(GOOGLE_STREAMING_MODES)
          .default(GOOGLE_GENERATE_CONTENT_TRANSPORT_DEFAULT.streaming),
        usage: z.enum(GOOGLE_USAGE_MODES).default(GOOGLE_GENERATE_CONTENT_TRANSPORT_DEFAULT.usage),
        inputEncoding: z
          .enum(GOOGLE_INPUT_ENCODINGS)
          .default(GOOGLE_GENERATE_CONTENT_TRANSPORT_DEFAULT.inputEncoding),
        apiVersion: z
          .enum(GOOGLE_API_VERSION_MODES)
          .default(GOOGLE_GENERATE_CONTENT_TRANSPORT_DEFAULT.apiVersion),
        automaticFunctionCalling: z
          .literal(false)
          .default(GOOGLE_GENERATE_CONTENT_TRANSPORT_DEFAULT.automaticFunctionCalling),
      })
      .strict(),
    z.strictObject({ schemaVersion: version, dialect: z.literal("command-code-router") }),
    z.strictObject({ schemaVersion: version, dialect: z.literal("deterministic") }),
    z.strictObject({ schemaVersion: version, dialect: z.literal("openai-codex-unavailable") }),
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
