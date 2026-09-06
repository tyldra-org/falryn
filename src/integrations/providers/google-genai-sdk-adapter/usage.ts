import type { GenerateContentResponse } from "@google/genai";
import type { UsageUnits } from "../../../providers/protocol/stream.ts";
import { GoogleInputError } from "./errors.ts";

function nonnegativeInteger(value: number | undefined, name: string): number {
  if (value === undefined) {
    return 0;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GoogleInputError("malformed-stream", `Google reported invalid ${name} usage.`);
  }
  return value;
}

export function usageFrom(response: GenerateContentResponse): UsageUnits | null {
  const usage = response.usageMetadata;
  if (usage === undefined) {
    return null;
  }
  const inputTokens =
    nonnegativeInteger(usage.promptTokenCount, "prompt-token") +
    nonnegativeInteger(usage.toolUsePromptTokenCount, "tool-use-prompt-token");
  const outputTokens = nonnegativeInteger(usage.candidatesTokenCount, "candidate-token");
  const reasoningTokens =
    usage.thoughtsTokenCount === undefined
      ? undefined
      : nonnegativeInteger(usage.thoughtsTokenCount, "thought-token");
  const cachedInputTokens =
    usage.cachedContentTokenCount === undefined
      ? undefined
      : nonnegativeInteger(usage.cachedContentTokenCount, "cached-content-token");
  const totalTokens =
    usage.totalTokenCount === undefined
      ? undefined
      : nonnegativeInteger(usage.totalTokenCount, "total-token");
  if (cachedInputTokens !== undefined && cachedInputTokens > inputTokens) {
    throw new GoogleInputError(
      "malformed-stream",
      "Google reported more cached input tokens than total input tokens.",
    );
  }
  if (
    totalTokens !== undefined &&
    totalTokens < inputTokens + outputTokens + (reasoningTokens ?? 0)
  ) {
    throw new GoogleInputError(
      "malformed-stream",
      "Google reported an inconsistent total-token count.",
    );
  }
  return {
    provenance: "provider-reported",
    inputTokens,
    outputTokens,
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

export function usageDoesNotRegress(previous: UsageUnits | null, next: UsageUnits): boolean {
  if (previous === null) {
    return true;
  }
  const values = [
    [previous.inputTokens, next.inputTokens],
    [previous.outputTokens, next.outputTokens],
    [previous.totalTokens, next.totalTokens],
    [previous.cachedInputTokens, next.cachedInputTokens],
    [previous.cacheWriteInputTokens, next.cacheWriteInputTokens],
    [previous.reasoningTokens, next.reasoningTokens],
  ] as const;
  return values.every(
    ([before, after]) => before === undefined || after === undefined || after >= before,
  );
}
