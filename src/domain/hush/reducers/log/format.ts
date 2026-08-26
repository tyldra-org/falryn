/** Compact, order-preserving projection for complete short journal records. */

const SHORT_JOURNAL_LINE =
  /^(\p{L}{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\S+)\s+([^:]+):(?:\s?(.*))$/u;
const JOURNAL_LEVEL =
  /^(TRACE|DEBUG|INFO|NOTICE|WARN(?:ING)?|ERROR|CRITICAL|ALERT|EMERG(?:ENCY)?)\b[\s:|-]*(.*)$/iu;

type JournalRecord = Readonly<{
  group: string;
  second: string;
  level: string;
  message: string;
  source: string;
}>;

export function formatShortJournal(source: string): string | null {
  const trailingNewline = source.endsWith("\n");
  const lines = source.split("\n");
  if (trailingNewline) {
    lines.pop();
  }
  if (lines.length === 0) {
    return null;
  }

  const records: JournalRecord[] = [];
  for (const line of lines) {
    const record = parseShortJournalLine(line);
    if (record === null) {
      return null;
    }
    records.push(record);
  }

  const formatted: string[] = [];
  for (let index = 0; index < records.length; ) {
    const first = records[index];
    if (first === undefined) {
      return null;
    }
    formatted.push(first.group);
    while (index < records.length && records[index]?.group === first.group) {
      const record = records[index];
      if (record === undefined) {
        return null;
      }
      let end = index + 1;
      while (end < records.length && records[end]?.source === record.source) {
        end += 1;
      }
      const count = end - index;
      const message = record.message.length === 0 ? "" : ` ${record.message}`;
      const repeats = count > 1 ? ` ×${count}` : "";
      formatted.push(`${record.second} [${record.level}]${message}${repeats}`);
      index = end;
    }
  }

  const result = formatted.join("\n");
  return trailingNewline ? `${result}\n` : result;
}

function parseShortJournalLine(line: string): JournalRecord | null {
  const match = SHORT_JOURNAL_LINE.exec(line);
  if (match === null) {
    return null;
  }
  const month = match[1];
  const day = match[2];
  const hour = match[3];
  const minute = match[4];
  const second = match[5];
  const host = match[6];
  const unit = match[7];
  const originalMessage = match[8];
  if (
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    host === undefined ||
    unit === undefined ||
    originalMessage === undefined
  ) {
    return null;
  }

  const levelMatch = JOURNAL_LEVEL.exec(originalMessage);
  const level = levelMatch?.[1];
  const message = levelMatch?.[2] ?? originalMessage;
  const marker = level === undefined ? "-" : levelMarker(level);
  return {
    group: `${month} ${Number.parseInt(day, 10)} ${hour}:${minute} ${host} ${unit}`,
    second,
    level: marker,
    message,
    source: line,
  };
}

function levelMarker(level: string): string {
  switch (level.toLowerCase()) {
    case "trace":
      return "T";
    case "debug":
      return "D";
    case "info":
      return "I";
    case "notice":
      return "N";
    case "warn":
    case "warning":
      return "W";
    case "error":
      return "E";
    case "critical":
      return "C";
    case "alert":
      return "A";
    case "emerg":
    case "emergency":
      return "M";
    default:
      return "-";
  }
}
