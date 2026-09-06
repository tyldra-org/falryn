import { booleanField, numberField, parseJson, record, stringField } from "./json.ts";

/** Repository identity and health facts useful to a coding agent, without README duplication. */
export function formatGithubRepoView(text: string): string | null {
  const json = parseJson(text);
  const value = json === null ? null : record(json);
  if (value === null) {
    return null;
  }
  const name = stringField(value, "nameWithOwner");
  const visibility = stringField(value, "visibility");
  const descriptionValue = value.description;
  const description = typeof descriptionValue === "string" ? descriptionValue : "";
  const url = stringField(value, "url");
  const stars = numberField(value, "stargazerCount");
  const forks = numberField(value, "forkCount");
  const archived = booleanField(value, "isArchived");
  if (
    name === null ||
    visibility === null ||
    (descriptionValue !== null && typeof descriptionValue !== "string") ||
    url === null ||
    stars === null ||
    forks === null ||
    archived === null
  ) {
    return null;
  }
  return [
    `${name} ${visibility.toLowerCase()}${archived ? " archived" : ""}`,
    ...(description.length === 0 ? [] : [description]),
    `${stars} stars ${forks} forks`,
    url,
  ].join("\n");
}
