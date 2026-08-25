import type { JsonRecord } from "../github/json.ts";
import { numberField, parseJson, records, stringField } from "../github/json.ts";
import { optionalStringField, shortSha, singleLine } from "./fields.ts";

/** Keep every returned pipeline; the CLI/API pagination choice remains the caller's. */
export function formatGitlabPipelineList(text: string): string | null {
  const json = parseJson(text);
  const entries = json === null ? null : records(json);
  if (entries === null) {
    return null;
  }
  const lines = entries.map(pipelineLine);
  return lines.every((line): line is string => line !== null) ? lines.join("\n") : null;
}

function pipelineLine(entry: JsonRecord): string | null {
  const id = numberField(entry, "id");
  const status = stringField(entry, "status");
  const ref = stringField(entry, "ref");
  const sha = stringField(entry, "sha");
  const source = optionalStringField(entry, "source");
  const name = optionalStringField(entry, "name");
  if (
    id === null ||
    status === null ||
    ref === null ||
    sha === null ||
    source === null ||
    name === null ||
    [status, ref, sha, source, name].some(
      (value) => value !== undefined && singleLine(value) === null,
    )
  ) {
    return null;
  }
  const details = [source, name].filter(
    (value): value is string => value !== undefined && value.length > 0,
  );
  return `#${id} ${pipelineState(status)} ${ref}@${shortSha(sha)}${details.length === 0 ? "" : ` ${details.join(" ")}`}`;
}

export function pipelineState(value: string): string {
  switch (value.toLowerCase()) {
    case "success":
      return "ok";
    case "failed":
    case "failure":
      return "fail";
    case "canceled":
    case "cancelled":
      return "cancel";
    case "skipped":
      return "skip";
    case "running":
    case "in_progress":
      return "run";
    case "pending":
    case "created":
    case "waiting_for_resource":
    case "preparing":
    case "scheduled":
      return "wait";
    default:
      return value.toLowerCase().replaceAll("_", "-");
  }
}
