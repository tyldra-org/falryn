/** Structured capture plans for Hush-supported commands that need richer native facts. */

import { commandShape } from "../domain/hush/command-shape.ts";
import {
  githubCommand,
  githubCommandArguments,
  type HushGithubCommand,
  hasGithubOutputOverride,
} from "../domain/hush/github-command.ts";
import type { ProcessCaptureRequest } from "../domain/index.ts";

const GITHUB_FIELDS: Readonly<Partial<Record<HushGithubCommand, string>>> = {
  "pr-list": "number,title,state",
  "pr-view": "number,title,state,author,body,url,mergeable,statusCheckRollup",
  "issue-list": "number,title,state",
  "run-list": "databaseId,workflowName,status,conclusion",
  "repo-view": "nameWithOwner,visibility,description,url,stargazerCount,forkCount,isArchived",
  "release-list": "tagName,name,isLatest,isDraft,isPrerelease,publishedAt,createdAt",
};

export function prepareHushCaptureRequest(request: ProcessCaptureRequest): ProcessCaptureRequest {
  if (request.mode === "bash") {
    return request;
  }
  const shape = commandShape(request);
  const command = shape.compound ? null : githubCommand(shape.tokens);
  const fields = command === null ? undefined : GITHUB_FIELDS[command];
  if (
    command === null ||
    fields === undefined ||
    hasGithubOutputOverride(command, githubCommandArguments(shape.tokens))
  ) {
    return request;
  }
  return {
    ...request,
    argv: [...request.argv, "--json", fields],
  };
}
