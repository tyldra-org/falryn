import { describe, expect, test } from "bun:test";

import { duration } from "../domain/clock.ts";
import type { ProcessCaptureRequest } from "../domain/process-capture.ts";
import { prepareHushCaptureRequest } from "./hush-capture-command.ts";

type DirectCaptureRequest = Extract<ProcessCaptureRequest, { readonly argv: readonly string[] }>;

describe("Hush capture command preparation", () => {
  const structuredCases: readonly (readonly [string, readonly string[], string])[] = [
    ["pr list", ["pr", "list"], "number,title,state,author"],
    [
      "pr view",
      ["pr", "view", "42"],
      "number,title,state,author,body,url,mergeable,statusCheckRollup",
    ],
    ["issue list", ["issue", "list"], "number,title,state"],
    ["run list", ["run", "list"], "databaseId,workflowName,status,conclusion"],
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

  const overrideCases: readonly (readonly string[])[] = [
    ["pr", "list", "--json", "number,title"],
    ["pr", "view", "42", "--comments"],
    ["issue", "list", "--jq", ".[0].number"],
    ["run", "list", "--template", "{{.databaseId}}"],
  ];
  for (const argv of overrideCases) {
    test(`preserves explicit gh output requests: ${argv.join(" ")}`, () => {
      const request = command(argv);
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
