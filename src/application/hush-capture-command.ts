/** Structured capture plans for Hush-supported commands that need richer native facts. */

import {
  githubCommand,
  githubCommandArguments,
  type HushGithubCommand,
  hasGithubOutputOverride,
} from "../domain/hush/command/github.ts";
import {
  gitlabCommand,
  gitlabCommandArguments,
  hasGitlabOutputOverride,
} from "../domain/hush/command/gitlab.ts";
import { commandShape } from "../domain/hush/command/normalize.ts";
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
  if (shape.compound) {
    return request;
  }
  const github = githubCommand(shape.tokens);
  const fields = github === null ? undefined : GITHUB_FIELDS[github];
  if (
    github !== null &&
    fields !== undefined &&
    !hasGithubOutputOverride(github, githubCommandArguments(shape.tokens))
  ) {
    return {
      ...request,
      argv: [...request.argv, "--json", fields],
    };
  }
  const gitlab = gitlabCommand(shape.tokens);
  if (
    gitlab !== null &&
    gitlab !== "api" &&
    !hasGitlabOutputOverride(gitlab, gitlabCommandArguments(shape.tokens))
  ) {
    return { ...request, argv: [...request.argv, "--output", "json"] };
  }
  return request;
}
