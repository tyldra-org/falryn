import { describe, expect, test } from "bun:test";

import { duration } from "../domain/clock.ts";
import type { ProcessCaptureRequest } from "../domain/process-capture.ts";
import { prepareHushCaptureRequest } from "./hush-capture-command.ts";

type DirectCaptureRequest = Extract<ProcessCaptureRequest, { readonly argv: readonly string[] }>;

describe("Hush capture command preparation", () => {
  const structuredCases: readonly (readonly [string, readonly string[], string])[] = [
    ["pr list", ["pr", "list"], "number,title,state"],
    [
      "pr view",
      ["pr", "view", "42"],
      "number,title,state,author,body,url,mergeable,statusCheckRollup",
    ],
    ["issue list", ["issue", "list"], "number,title,state"],
    ["run list", ["run", "list"], "databaseId,workflowName,status,conclusion"],
    [
      "repo view",
      ["repo", "view"],
      "nameWithOwner,visibility,description,url,stargazerCount,forkCount,isArchived",
    ],
    [
      "release list",
      ["release", "list"],
      "tagName,name,isLatest,isDraft,isPrerelease,publishedAt,createdAt",
    ],
  ];
  for (const [label, argv, fields] of structuredCases) {
    test(`requests structured facts for gh ${label}`, () => {
      const request = command(argv);
      expect(prepareHushCaptureRequest(request)).toEqual({
        ...request,
        argv: [...argv, "--json", fields],
      });
    });
  }

  const gitlabStructuredCases: readonly (readonly [string, readonly string[]])[] = [
    ["mr list", ["mr", "list"]],
    ["issue list", ["issue", "list"]],
    ["ci status", ["ci", "status"]],
    ["pipeline list", ["pipeline", "list"]],
    ["release list", ["release", "list"]],
  ];
  for (const [label, argv] of gitlabStructuredCases) {
    test(`requests structured facts for glab ${label}`, () => {
      const request = command(argv, "/opt/homebrew/bin/glab");
      expect(prepareHushCaptureRequest(request)).toEqual({
        ...request,
        argv: [...argv, "--output", "json"],
      });
    });
  }

  const overrideCases: readonly (readonly string[])[] = [
    ["pr", "list", "--json", "number,title"],
    ["pr", "view", "42", "--comments"],
    ["issue", "list", "--jq", ".[0].number"],
    ["run", "list", "--template", "{{.databaseId}}"],
    ["repo", "view", "--branch", "release"],
    ["release", "list", "--json", "tagName"],
    ["api", "repos/tyldra-org/falryn"],
  ];
  for (const argv of overrideCases) {
    test(`preserves explicit gh output requests: ${argv.join(" ")}`, () => {
      const request = command(argv);
      expect(prepareHushCaptureRequest(request)).toBe(request);
    });
  }

  const gitlabOverrideCases: readonly (readonly string[])[] = [
    ["mr", "list", "--output", "text"],
    ["issue", "list", "--output-format", "ids"],
    ["ci", "status", "--live"],
    ["pipeline", "list", "--jq", ".[0].id"],
    ["api", "projects"],
    ["release", "list", "-F", "json"],
  ];
  for (const argv of gitlabOverrideCases) {
    test(`preserves explicit glab output requests: ${argv.join(" ")}`, () => {
      const request = command(argv, "/opt/homebrew/bin/glab");
      expect(prepareHushCaptureRequest(request)).toBe(request);
    });
  }

  test("does not rewrite Bash or unrelated direct commands", () => {
    const bash: ProcessCaptureRequest = {
      mode: "bash",
      executable: "/bin/bash",
      command: "gh pr list | head",
      environment: {},
      timeoutMs: duration(5_000),
      maxOutputBytes: 64 * 1_024,
    };
    const git = command(["status"], "/usr/bin/git");
    expect(prepareHushCaptureRequest(bash)).toBe(bash);
    expect(prepareHushCaptureRequest(git)).toBe(git);
  });
});

function command(
  argv: readonly string[],
  executable = "/opt/homebrew/bin/gh",
): DirectCaptureRequest {
  return {
    executable,
    argv,
    environment: {},
    timeoutMs: duration(5_000),
    maxOutputBytes: 64 * 1_024,
  };
}
