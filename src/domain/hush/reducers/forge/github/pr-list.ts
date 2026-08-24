import { loginField, numberField, parseJson, records, stateWord, stringField } from "./json.ts";

export function formatGithubPrList(text: string): string | null {
  const json = parseJson(text);
  if (json !== null) {
    const entries = records(json);
    if (entries === null) {
      return null;
    }
    if (entries.length === 0) {
      return "no prs";
    }
    const lines = entries.map((entry) => {
      const number = numberField(entry, "number");
      const title = stringField(entry, "title");
      const state = stringField(entry, "state");
      const author = loginField(entry, "author");
      return number === null || title === null || state === null
        ? null
        : `#${number} ${stateWord(state)} ${title}${author === null ? "" : ` @${author}`}`;
    });
    return lines.every((line): line is string => line !== null) ? lines.join("\n") : null;
  }
  return formatNativePrList(text);
}

function formatNativePrList(text: string): string | null {
  const lines = nonemptyLines(text);
  if (lines.length === 0) {
    return "no prs";
  }
  const formatted = lines.map((line) => {
    const fields = line.split("\t");
    if (fields.length !== 5) {
      return null;
    }
    const [number, title, , state] = fields;
    return number !== undefined && /^\d+$/u.test(number) && title && state
      ? `#${number} ${stateWord(state)} ${title}`
      : null;
  });
  return formatted.every((line): line is string => line !== null) ? formatted.join("\n") : null;
}

function nonemptyLines(text: string): readonly string[] {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}
