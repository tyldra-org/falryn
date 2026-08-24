import {
  type JsonRecord,
  loginField,
  numberField,
  parseJson,
  record,
  stateWord,
  stringField,
} from "./json.ts";

export function formatGithubPrView(text: string): string | null {
  const json = parseJson(text);
  if (json !== null) {
    const value = record(json);
    return value === null ? null : formatPrRecord(value);
  }
  return formatNativePrView(text);
}

function formatPrRecord(value: JsonRecord): string | null {
  const number = numberField(value, "number");
  const title = stringField(value, "title");
  const state = stringField(value, "state");
  const author = loginField(value, "author");
  const url = stringField(value, "url");
  if (number === null || title === null || state === null || author === null || url === null) {
    return null;
  }

  const lines = [`#${number} ${stateWord(state)} ${title}`];
  const facts = [`@${author}`];
  const mergeable = stringField(value, "mergeable");
  if (mergeable !== null) {
    facts.push(mergeableWord(mergeable));
  }
  lines.push(facts.join(" | "));

  const checks = checkSummary(value.statusCheckRollup);
  if (checks === null) {
    return null;
  }
  if (checks.length > 0) {
    lines.push(checks);
  }
  lines.push(url);

  const body = stringField(value, "body");
  if (body !== null && body.length > 0) {
    lines.push("--", body.trimEnd());
  }
  return lines.join("\n");
}

function checkSummary(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const entries = value.map(record);
  if (!entries.every((entry): entry is JsonRecord => entry !== null)) {
    return null;
  }
  if (entries.length === 0) {
    return "";
  }
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const entry of entries) {
    const conclusion = (
      stringField(entry, "conclusion") ??
      stringField(entry, "state") ??
      ""
    ).toUpperCase();
    const status = (stringField(entry, "status") ?? "").toUpperCase();
    if (conclusion === "SUCCESS") {
      passed += 1;
    } else if (
      ["FAILURE", "ACTION_REQUIRED", "STARTUP_FAILURE", "TIMED_OUT"].includes(conclusion)
    ) {
      failed += 1;
    } else if (status !== "COMPLETED" || conclusion.length === 0) {
      pending += 1;
    }
  }
  const other = entries.length - passed - failed - pending;
  return [
    `checks ${passed}/${entries.length} passed`,
    ...(failed === 0 ? [] : [`${failed} failed`]),
    ...(pending === 0 ? [] : [`${pending} pending`]),
    ...(other === 0 ? [] : [`${other} other`]),
  ].join(", ");
}

function mergeableWord(value: string): string {
  if (value === "MERGEABLE") {
    return "mergeable";
  }
  if (value === "CONFLICTING") {
    return "conflicts";
  }
  return stateWord(value);
}

function formatNativePrView(text: string): string | null {
  const sourceLines = text.split("\n");
  const separator = sourceLines.indexOf("--");
  const metadataLines = (separator === -1 ? sourceLines : sourceLines.slice(0, separator)).filter(
    (line) => line.length > 0,
  );
  const metadata = new Map<string, string>();
  for (const line of metadataLines) {
    const split = line.indexOf(":\t");
    if (split === -1) {
      return null;
    }
    metadata.set(line.slice(0, split), line.slice(split + 2));
  }
  const number = metadata.get("number");
  const title = metadata.get("title");
  const state = metadata.get("state");
  const author = metadata.get("author")?.split(" ", 1)[0];
  const url = metadata.get("url");
  if (!number || !/^\d+$/u.test(number) || !title || !state || !author || !url) {
    return null;
  }
  const lines = [`#${number} ${stateWord(state)} ${title}`, `@${author}`];
  lines.push(url);
  if (separator !== -1) {
    const body = sourceLines
      .slice(separator + 1)
      .join("\n")
      .trimEnd();
    if (body.length > 0) {
      lines.push("--", body);
    }
  }
  return lines.join("\n");
}
