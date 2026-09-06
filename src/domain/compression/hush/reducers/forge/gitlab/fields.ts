import type { JsonRecord } from "../github/json.ts";

export function optionalStringField(value: JsonRecord, key: string): string | null | undefined {
  const field = value[key];
  return field === undefined || field === null
    ? undefined
    : typeof field === "string"
      ? field
      : null;
}

export function optionalBooleanField(value: JsonRecord, key: string): boolean | null | undefined {
  const field = value[key];
  return field === undefined || field === null
    ? undefined
    : typeof field === "boolean"
      ? field
      : null;
}

export function singleLine(value: string): string | null {
  return /[\r\n]/u.test(value) ? null : value;
}

export function shortSha(value: string): string {
  return value.length > 8 ? value.slice(0, 8) : value;
}
