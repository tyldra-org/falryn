import type { JsonRecord } from "../github/json.ts";
import { parseJson, records, stringField } from "../github/json.ts";
import { optionalBooleanField, optionalStringField, singleLine } from "./fields.ts";

/** Keep every release tag, name, and schedule/date without repeating repository metadata. */
export function formatGitlabReleaseList(text: string): string | null {
  const json = parseJson(text);
  const entries = json === null ? null : records(json);
  if (entries === null) {
    return null;
  }
  const lines = entries.map(releaseLine);
  return lines.every((line): line is string => line !== null) ? lines.join("\n") : null;
}

function releaseLine(entry: JsonRecord): string | null {
  const tag = stringField(entry, "tag_name");
  const name = stringField(entry, "name");
  const upcoming = optionalBooleanField(entry, "upcoming_release");
  const releasedAt = optionalStringField(entry, "released_at");
  const createdAt = optionalStringField(entry, "created_at");
  if (
    tag === null ||
    name === null ||
    upcoming === null ||
    releasedAt === null ||
    createdAt === null ||
    [tag, name, releasedAt, createdAt].some(
      (value) => value !== undefined && singleLine(value) === null,
    )
  ) {
    return null;
  }
  const date = (releasedAt ?? createdAt ?? "").slice(0, 10);
  const title = name.length === 0 || name === tag ? tag : `${tag} ${name}`;
  return `${upcoming === true ? "upcoming" : "release"} ${title}${date.length === 0 ? "" : ` ${date}`}`;
}
