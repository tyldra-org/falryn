/** Order-preserving container log projection with no record-count cap. */

import { shortestText } from "../shared/text.ts";
import { containerLines } from "./shared.ts";

const ISO_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:\d{2})\s+(.*)$/u;
const COMPOSE_PREFIX = /^([\p{L}\p{N}_.-]+)\s+\|\s?(.*)$/u;

type ContainerLogRecord = Readonly<{
  scope: string | null;
  day: string | null;
  time: string | null;
  zone: string | null;
  message: string;
}>;

export function formatContainerLogOutput(text: string): string | null {
  const trailingNewline = text.endsWith("\n");
  const lines = containerLines(text);
  if (lines.length === 0) return null;
  const records: ContainerLogRecord[] = [];
  for (const line of lines) {
    const parsed = parseRecord(line);
    if (parsed === null) return null;
    records.push(parsed);
  }

  const output: string[] = [];
  let activeGroup: string | null = null;
  for (const record of records) {
    const group = groupLabel(record);
    if (group !== activeGroup) {
      output.push(group);
      activeGroup = group;
    }
    output.push(record.time === null ? record.message : `${record.time} ${record.message}`);
  }
  const formatted = output.join("\n");
  return shortestText(text, trailingNewline ? `${formatted}\n` : formatted);
}

function parseRecord(line: string): ContainerLogRecord | null {
  const compose = COMPOSE_PREFIX.exec(line);
  const scope = compose?.[1]?.trim() ?? null;
  const payload = compose?.[2] ?? line;
  const timestamp = ISO_TIMESTAMP.exec(payload);
  if (timestamp === null) {
    return scope === null ? null : { scope, day: null, time: null, zone: null, message: payload };
  }
  return {
    scope,
    day: timestamp[1] ?? null,
    time: timestamp[2] ?? null,
    zone: timestamp[3] ?? null,
    message: timestamp[4] ?? "",
  };
}

function groupLabel(record: ContainerLogRecord): string {
  const scope = record.scope === null ? "" : `[${record.scope}]`;
  const date = record.day === null ? "" : `${record.day}${record.zone ?? ""}`;
  return [scope, date].filter((part) => part.length > 0).join(" ");
}
