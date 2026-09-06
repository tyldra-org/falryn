import { booleanField, type JsonRecord, parseJson, records, stringField } from "./json.ts";

type ReleaseRow = Readonly<{
  state: "latest" | "draft" | "pre" | "release";
  title: string;
  date: string;
}>;

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
  const rows = entries.map(releaseRow);
  return rows.every((row): row is ReleaseRow => row !== null) ? formatRows(rows) : null;
}

function releaseRow(value: JsonRecord): ReleaseRow | null {
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
  return { state, title, date };
}

/** Factor repeated release states while retaining every tag, name, date, and original position. */
function formatRows(rows: readonly ReleaseRow[]): string {
  const chunks: string[] = [];
  for (let start = 0; start < rows.length; ) {
    const state = rows[start]?.state;
    let end = start + 1;
    while (end < rows.length && rows[end]?.state === state) {
      end += 1;
    }
    const group = rows.slice(start, end);
    const plain = group.map(formatRelease).join("\n");
    const grouped = `${state}:\n${group.map(formatReleaseBody).join("\n")}`;
    chunks.push(byteLength(grouped) < byteLength(plain) ? grouped : plain);
    start = end;
  }
  return chunks.join("\n");
}

function formatRelease(row: ReleaseRow): string {
  return `${row.state} ${formatReleaseBody(row)}`;
}

function formatReleaseBody(row: ReleaseRow): string {
  return `${row.title}${row.date.length === 0 ? "" : ` ${row.date}`}`;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function releaseDate(value: JsonRecord): string | null {
  const published = value.publishedAt;
  if (typeof published === "string") {
    return published;
  }
  return published === null ? stringField(value, "createdAt") : null;
}
