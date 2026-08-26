import type { JsonRecord } from "../github/json.ts";
import {
  booleanField,
  numberField,
  parseJson,
  record,
  records,
  stringField,
} from "../github/json.ts";
import { optionalStringField, shortSha, singleLine } from "./fields.ts";
import { pipelineState } from "./pipeline-list.ts";

/** Pipeline identity plus every job and failure fact, with no job-count cap. */
export function formatGitlabCiStatus(text: string): string | null {
  const json = parseJson(text);
  const value = json === null ? null : record(json);
  const pipeline = value === null ? null : record(value.pipeline);
  const jobs = value === null ? null : records(value.jobs);
  if (pipeline === null || jobs === null) {
    return null;
  }
  const header = pipelineHeader(pipeline);
  const jobLines = jobs.map(jobLine);
  if (header === null || !jobLines.every((line): line is string => line !== null)) {
    return null;
  }
  return [header, ...(jobLines.length === 0 ? [] : ["jobs:", ...jobLines])].join("\n");
}

function pipelineHeader(pipeline: JsonRecord): string | null {
  const id = numberField(pipeline, "id");
  const status = stringField(pipeline, "status");
  const ref = stringField(pipeline, "ref");
  const sha = stringField(pipeline, "sha");
  const url = optionalStringField(pipeline, "web_url");
  if (
    id === null ||
    status === null ||
    ref === null ||
    sha === null ||
    url === null ||
    [status, ref, sha, url].some((value) => value !== undefined && singleLine(value) === null)
  ) {
    return null;
  }
  return `#${id} ${pipelineState(status)} ${ref}@${shortSha(sha)}${url === undefined || url.length === 0 ? "" : ` ${url}`}`;
}

function jobLine(job: JsonRecord): string | null {
  const id = numberField(job, "id");
  const name = stringField(job, "name");
  const stage = stringField(job, "stage");
  const status = stringField(job, "status");
  const allowFailure = booleanField(job, "allow_failure");
  const failureReason = optionalStringField(job, "failure_reason");
  if (
    id === null ||
    name === null ||
    stage === null ||
    status === null ||
    allowFailure === null ||
    failureReason === null ||
    [name, stage, status, failureReason].some(
      (value) => value !== undefined && singleLine(value) === null,
    )
  ) {
    return null;
  }
  const reason =
    failureReason === undefined || failureReason.length === 0 ? "" : ` ${failureReason}`;
  return `${pipelineState(status)} #${id} ${name} [${stage}]${allowFailure ? " allowed" : ""}${reason}`;
}
