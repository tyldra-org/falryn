/** Complete cloud-CLI projections that retain every returned value. */

import { compactJsonWhitespace, shortestText } from "../../text-format.ts";
import { formatAlignedTable } from "../table/format.ts";

export const CLOUD_EXECUTABLES = new Set(["aws", "gcloud", "az"]);

export function formatCloudOutput(text: string, commandTokens: readonly string[]): string | null {
  const executable = commandTokens[0]?.split(/[\\/]/u).at(-1);
  if (executable === "aws") {
    return (
      formatAwsIdentity(text, commandTokens) ??
      formatAwsS3Listing(text, commandTokens) ??
      formatAwsDynamoScan(text, commandTokens) ??
      compactJsonWhitespace(text) ??
      formatFixedWidthTable(text) ??
      formatAlignedTable(text)
    );
  }
  if (executable === "gcloud" || executable === "az") {
    return compactJsonWhitespace(text) ?? formatFixedWidthTable(text) ?? formatAlignedTable(text);
  }
  return null;
}

function formatFixedWidthTable(text: string): string | null {
  const trailingNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (trailingNewline) lines.pop();
  const header = lines[0];
  if (header === undefined || lines.length < 2) return null;
  const starts = [...header.matchAll(/\S(?:.*?\S)?(?=\s{2,}|$)/gu)].map((match) => match.index);
  if (starts.length < 2 || starts[0] !== 0) return null;
  const rows = lines.map((line) =>
    starts.map((start, index) => line.slice(start, starts[index + 1]).trim()).join("\t"),
  );
  const formatted = rows.join("\n");
  return shortestText(text, trailingNewline ? `${formatted}\n` : formatted);
}

function formatAwsIdentity(text: string, commandTokens: readonly string[]): string | null {
  if (commandTokens[1] !== "sts" || commandTokens[2] !== "get-caller-identity") return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const account = value.Account;
  const arn = value.Arn;
  const id = value.UserId;
  if (typeof account !== "string" || typeof arn !== "string" || typeof id !== "string") {
    return null;
  }
  const arnParts = arn.split(":");
  if (arnParts[4] !== account || arnParts[5] === undefined) return null;
  const resource = arnParts.slice(5).join(":").replace("/", "=");
  return shortestText(text, `account=${account} ${resource} id=${id}`);
}

function formatAwsS3Listing(text: string, commandTokens: readonly string[]): string | null {
  if (commandTokens[1] !== "s3" || commandTokens[2] !== "ls") return null;
  const trailingNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (trailingNewline) lines.pop();
  if (lines.length === 0) return null;
  const output: string[] = [];
  for (const line of lines) {
    const object = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+(\d+)\s+(.+)$/u.exec(line);
    if (object !== null) {
      output.push(`${object[1]}T${object[2]}\t${object[3]}\t${object[4]}`);
      continue;
    }
    const prefix = /^\s*PRE\s+(.+)$/u.exec(line);
    if (prefix !== null) {
      output.push(`dir\t${prefix[1]}`);
      continue;
    }
    return null;
  }
  const formatted = output.join("\n");
  return shortestText(text, trailingNewline ? `${formatted}\n` : formatted);
}

function formatAwsDynamoScan(text: string, commandTokens: readonly string[]): string | null {
  if (commandTokens[1] !== "dynamodb" || commandTokens[2] !== "scan") return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || !Array.isArray(value.Items)) return null;
  const items = value.Items;
  const count = value.Count;
  const scanned = value.ScannedCount;
  if (typeof count !== "number" || typeof scanned !== "number" || items.length === 0) return null;
  const first = items[0];
  if (!isRecord(first)) return null;
  const columns = Object.entries(first).map(([key, attribute]) => {
    const parsed = parseDynamoAttribute(attribute);
    return parsed === null ? null : { key, type: parsed.type };
  });
  if (columns.some((column) => column === null)) return null;
  const typedColumns = columns.filter((column) => column !== null);
  const rows: string[] = [typedColumns.map((column) => `${column.key}:${column.type}`).join("\t")];
  for (const item of items) {
    if (!isRecord(item) || Object.keys(item).length !== typedColumns.length) return null;
    const cells: string[] = [];
    for (const column of typedColumns) {
      const attribute = parseDynamoAttribute(item[column.key]);
      if (attribute === null || attribute.type !== column.type) return null;
      cells.push(attribute.value);
    }
    rows.push(cells.join("\t"));
  }
  rows.push(`count=${count} scanned=${scanned}`);
  return shortestText(text, rows.join("\n"));
}

function parseDynamoAttribute(value: unknown): Readonly<{ type: string; value: string }> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length !== 1) return null;
  const [type, attribute] = entries[0] ?? [];
  return typeof type === "string" && typeof attribute === "string"
    ? { type, value: attribute }
    : null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
