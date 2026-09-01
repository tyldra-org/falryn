/** Order-preserving Kubernetes log projection with no record-count cap. */

import { shortestText } from "../shared/text.ts";
import { kubernetesLines } from "./shared.ts";

const ISO_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:\d{2})\s+(.*)$/u;
const SOURCE_PREFIX = /^\[(pod\/[^\]/\s]+\/container\/[^\]\s]+)\]\s?(.*)$/u;

type KubernetesLogRecord = Readonly<{
  source: string | null;
  day: string | null;
  time: string | null;
  zone: string | null;
  message: string;
}>;

export function formatKubernetesLogOutput(text: string): string | null {
  const trailingNewline = text.endsWith("\n");
  const records: KubernetesLogRecord[] = [];
  for (const line of kubernetesLines(text)) {
    const parsed = parseRecord(line);
    if (parsed === null) return null;
    records.push(parsed);
  }
  if (records.length === 0) return null;

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

function parseRecord(line: string): KubernetesLogRecord | null {
  const prefixed = SOURCE_PREFIX.exec(line);
  const source = prefixed?.[1] ?? null;
  const payload = prefixed?.[2] ?? line;
  const timestamp = ISO_TIMESTAMP.exec(payload);
  if (timestamp === null) {
    return source === null ? null : { source, day: null, time: null, zone: null, message: payload };
  }
  const timestampMessage = timestamp[4] ?? "";
  const timestampPrefix = source === null ? SOURCE_PREFIX.exec(timestampMessage) : null;
  return {
    source: source ?? timestampPrefix?.[1] ?? null,
    day: timestamp[1] ?? null,
    time: timestamp[2] ?? null,
    zone: timestamp[3] ?? null,
    message: timestampPrefix?.[2] ?? timestampMessage,
  };
}

function groupLabel(record: KubernetesLogRecord): string {
  const source = record.source === null ? "" : `[${record.source}]`;
  const date = record.day === null ? "" : `${record.day}${record.zone ?? ""}`;
  return [source, date].filter((part) => part.length > 0).join(" ");
}
