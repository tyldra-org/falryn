import type { NotebookJsonValue } from "../../../domain/documents/index.ts";
import type { RenderBudget, RenderedText } from "./contracts.ts";
import { isRecord } from "./parsing.ts";

export function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function truncateUtf8(value: string, maxBytes: number): RenderedText {
  const sourceBytes = byteLength(value);
  if (sourceBytes <= maxBytes) {
    return { value, truncated: false, omittedBytes: 0 };
  }
  const encoded = Buffer.from(value, "utf8");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let length = Math.max(0, maxBytes); length > 0; length -= 1) {
    try {
      const truncated = decoder.decode(encoded.subarray(0, length));
      return {
        value: truncated,
        truncated: true,
        omittedBytes: sourceBytes - byteLength(truncated),
      };
    } catch {}
  }
  return { value: "", truncated: true, omittedBytes: sourceBytes };
}

export function renderText(
  value: string,
  budget: RenderBudget,
  maxItemBytes: number,
): RenderedText {
  const allowedBytes = Math.min(maxItemBytes, budget.remainingBytes);
  const rendered = truncateUtf8(value, allowedBytes);
  budget.remainingBytes -= byteLength(rendered.value);
  if (budget.remainingBytes === 0) {
    budget.exhausted = true;
  }
  return rendered;
}

export function safeJsonStringify(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "null" : serialized;
}

export function toNotebookJsonValue(value: unknown, depth = 0): NotebookJsonValue {
  if (value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (depth > 32) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toNotebookJsonValue(item, depth + 1));
  }
  if (isRecord(value)) {
    const result: Record<string, NotebookJsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = toNotebookJsonValue(value[key], depth + 1);
    }
    return result;
  }
  return null;
}

export function textField(value: unknown): { readonly value: string; readonly valid: boolean } {
  if (typeof value === "string") {
    return { value, valid: true };
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return { value: value.join(""), valid: true };
  }
  return { value: "", valid: false };
}
