/** Structured capture plans for Hush-supported commands that need richer native facts. */

import { commandShape } from "../domain/hush/command-shape.ts";
import {
  githubCommand,
  githubCommandArguments,
  type HushGithubCommand,
  hasGithubOutputOverride,
} from "../domain/hush/github-command.ts";
import type { ProcessCaptureRequest } from "../domain/index.ts";

const GITHUB_FIELDS: Readonly<Record<HushGithubCommand, string>> = {
  "pr-list": "number,title,state,author",
  "pr-view": "number,title,state,author,body,url,mergeable,statusCheckRollup",
  "issue-list": "number,title,state",
  "run-list": "databaseId,workflowName,status,conclusion",
};

export function prepareHushCaptureRequest(request: ProcessCaptureRequest): ProcessCaptureRequest {
  if (request.mode === "bash") {
    return request;
  }
  const shape = commandShape(request);
  const command = shape.compound ? null : githubCommand(shape.tokens);
  if (command === null || hasGithubOutputOverride(command, githubCommandArguments(shape.tokens))) {
    return request;
  }
  return {
    ...request,
    argv: [...request.argv, "--json", GITHUB_FIELDS[command]],
  };
}
