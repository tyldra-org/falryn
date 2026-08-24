export type JsonRecord = Readonly<Record<string, unknown>>;

export function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

export function records(value: unknown): readonly JsonRecord[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const parsed = value.map(record);
  return parsed.every((entry): entry is JsonRecord => entry !== null) ? parsed : null;
}

export function stringField(value: JsonRecord, key: string): string | null {
  const field = value[key];
  return typeof field === "string" ? field : null;
}

export function numberField(value: JsonRecord, key: string): number | null {
  const field = value[key];
  return typeof field === "number" && Number.isSafeInteger(field) ? field : null;
}

export function loginField(value: JsonRecord, key: string): string | null {
  const owner = record(value[key]);
  return owner === null ? null : stringField(owner, "login");
}

export function stateWord(value: string): string {
  return value.toLowerCase().replaceAll("_", "-");
}
