import { numberField, parseJson, records, stringField } from "./json.ts";
import { visibleState } from "./list-state.ts";

export function formatGithubIssueList(text: string, args: readonly string[] = []): string | null {
  const json = parseJson(text);
  if (json !== null) {
    const entries = records(json);
    if (entries === null) {
      return null;
    }
    if (entries.length === 0) {
      return "";
    }
    const lines = entries.map((entry) => {
      const number = numberField(entry, "number");
      const title = stringField(entry, "title");
      const state = stringField(entry, "state");
      if (number === null || title === null || state === null) {
        return null;
      }
      return `${number} ${visibleState(state, args)}${title}`;
    });
    return lines.every((line): line is string => line !== null) ? lines.join("\n") : null;
  }
  return formatNativeIssueList(text, args);
}

function formatNativeIssueList(text: string, args: readonly string[]): string | null {
  const lines = text.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) {
    return "";
  }
  const formatted = lines.map((line) => {
    const fields = line.split("\t");
    if (fields.length !== 5) {
      return null;
    }
    const [number, state, title, labels] = fields;
    if (
      number === undefined ||
      !/^\d+$/u.test(number) ||
      !state ||
      !title ||
      labels === undefined
    ) {
      return null;
    }
    return `${number} ${visibleState(state, args)}${title}`;
  });
  return formatted.every((line): line is string => line !== null) ? formatted.join("\n") : null;
}
