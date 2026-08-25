import { booleanField, type JsonRecord, parseJson, records, stringField } from "./json.ts";

/** Compact every release row without imposing an item cap. */
export function formatGithubReleaseList(text: string): string | null {
  const json = parseJson(text);
  if (json === null) {
    return null;
  }
  const entries = records(json);
  if (entries === null) {
    return null;
  }
  const lines = entries.map(formatRelease);
  return lines.every((line): line is string => line !== null) ? lines.join("\n") : null;
}

function formatRelease(value: JsonRecord): string | null {
  const tag = stringField(value, "tagName");
  const name = stringField(value, "name");
  const latest = booleanField(value, "isLatest");
  const draft = booleanField(value, "isDraft");
  const prerelease = booleanField(value, "isPrerelease");
  const publishedAt = releaseDate(value);
  if (
    tag === null ||
    name === null ||
    latest === null ||
    draft === null ||
    prerelease === null ||
    publishedAt === null
  ) {
    return null;
  }
  const state = latest ? "latest" : draft ? "draft" : prerelease ? "pre" : "release";
  const title = name.length === 0 || name === tag ? tag : `${tag} ${name}`;
  const date = publishedAt.slice(0, 10);
  return `${state} ${title}${date.length === 0 ? "" : ` ${date}`}`;
}

function releaseDate(value: JsonRecord): string | null {
  const published = value.publishedAt;
  if (typeof published === "string") {
    return published;
  }
  return published === null ? stringField(value, "createdAt") : null;
}
