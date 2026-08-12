/**
 * Normalized conversation messages at the provider boundary.
 *
 * Content is Falryn-owned text (and later modalities). Provider SDK message
 * objects never appear here.
 */

import type { ModelRole } from "./roles.ts";

export const MESSAGE_ROLES = ["system", "user", "assistant", "tool"] as const;

export type MessageRole = (typeof MESSAGE_ROLES)[number];

export function isMessageRole(value: unknown): value is MessageRole {
  return typeof value === "string" && (MESSAGE_ROLES as readonly string[]).includes(value);
}

export type TextMessagePart = {
  readonly kind: "text";
  readonly text: string;
};

/**
 * Image parts are declared so the request schema can reject or accept them
 * without inventing a vision adapter. Bytes stay out of events; a handle is a
 * stable artifact or URI reference owned elsewhere.
 */
export type ImageMessagePart = {
  readonly kind: "image";
  readonly handle: string;
  readonly mediaType: string;
};

export type MessagePart = TextMessagePart | ImageMessagePart;

export type ModelMessage = {
  readonly role: MessageRole;
  readonly parts: readonly MessagePart[];
  /** Present when this message is a tool result tied to a prior proposal. */
  readonly toolCallId?: string | undefined;
};

export type ModelToolDefinition = {
  readonly name: string;
  readonly description: string;
  /** JSON Schema object for arguments; validated as structure, not executed. */
  readonly parameters: Readonly<Record<string, unknown>>;
};

export type OutputContract =
  | { readonly kind: "text" }
  | {
      readonly kind: "json-schema";
      readonly name: string;
      readonly schema: Readonly<Record<string, unknown>>;
    };

export type ModelBudgets = {
  readonly maxInputTokens?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly wallTimeMs?: number | undefined;
};

export type RequestMetadata = {
  readonly role: ModelRole;
  readonly workIntent?: string | undefined;
  /** Configuration generation observed when the request was built. */
  readonly configurationGeneration?: number | undefined;
};
