import { numberField, parseJson, records, stringField } from "../github/json.ts";
import { singleLine } from "./fields.ts";
import { visibleGitlabState } from "./state.ts";

/** Keep every issue identity, state, and complete title without imposing an item cap. */
export function formatGitlabIssueList(text: string, args: readonly string[] = []): string | null {
  const json = parseJson(text);
  const entries = json === null ? null : records(json);
  if (entries === null) {
    return null;
  }
  const lines = entries.map((entry) => {
    const iid = numberField(entry, "iid");
    const title = stringField(entry, "title");
    const state = stringField(entry, "state");
    if (iid === null || title === null || state === null || singleLine(title) === null) {
      return null;
    }
    return `#${iid} ${visibleGitlabState(state, args, "issue")}${title}`;
  });
  return lines.every((line): line is string => line !== null) ? lines.join("\n") : null;
}
