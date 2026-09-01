import { describe, expect, test } from "bun:test";

import { helpText, parseInvocation } from "./command-tree.ts";
import { dispatch } from "./dispatch.ts";
import { EXIT_CODES } from "./exit.ts";
import {
  COMPLETION_SHELLS,
  completionInstallScript,
  DECLARED_TOP_LEVEL_GROUPS,
  getCompletionCandidates,
  isCompletionRequest,
  UNDECLARED_GROUPS,
} from "./shell-completion.ts";
import { createRecordingCliStreams } from "./streams.ts";

describe("shell completion", () => {
  test("parses completion for each supported shell", async () => {
    for (const shell of COMPLETION_SHELLS) {
      const invocation = await parseInvocation(["completion", shell]);
      expect(invocation.kind).toBe("run");
      if (invocation.kind !== "run") {
        continue;
      }
      expect(invocation.command).toBe("completion");
      expect(invocation.completionArgs).toEqual({ shell });
    }
  });

  test("refuses an unknown shell", async () => {
    const invocation = await parseInvocation(["completion", "powershell"]);
    expect(invocation.kind).toBe("invalid");
  });

  test("declares completion in help without yargs hidden machinery", async () => {
    const text = await helpText(null);
    expect(text).toContain("completion <shell>");
    expect(text).not.toContain("get-yargs-completions");
  });

  test("install scripts call runtime completion through the declared flag", () => {
    for (const shell of COMPLETION_SHELLS) {
      const script = completionInstallScript(shell, "/usr/local/bin/falryn");
      expect(script).toContain("--get-yargs-completions");
      expect(script).toContain("/usr/local/bin/falryn");
      expect(script).toContain("falryn");
    }
  });

  test("offers only declared top-level groups at the root", () => {
    const candidates = getCompletionCandidates([]);
    for (const group of DECLARED_TOP_LEVEL_GROUPS) {
      expect(candidates).toContain(group);
    }
    for (const group of UNDECLARED_GROUPS) {
      expect(candidates).not.toContain(group);
    }
  });

  test("offers declared config actions after the group", () => {
    const candidates = getCompletionCandidates(["config", ""]);
    expect(candidates).toEqual(expect.arrayContaining(["show", "validate", "path", "set"]));
  });

  test("offers human controls without exposing backend raw names", () => {
    expect(getCompletionCandidates(["run", "--brief", ""])).toEqual(
      expect.arrayContaining(["compact", "balanced", "detailed", "auto", "on", "off"]),
    );
    expect(getCompletionCandidates(["run", "--hush", ""])).toEqual(["on", "off"]);
    expect(getCompletionCandidates(["run", "--loom", ""])).toEqual(["on", "off"]);
    expect(getCompletionCandidates(["run", "--hush", ""])).not.toContain("raw");
  });

  test("answers runtime completion on stdout without constructing services", async () => {
    const streams = createRecordingCliStreams();
    const code = await dispatch({
      argv: ["--get-yargs-completions", "session", ""],
      streams,
      services: () => {
        throw new Error("completion must not construct services");
      },
    });
    expect(code).toBe(EXIT_CODES.COMPLETED);
    const output = streams.resultWrites().join("");
    expect(output).toContain("list");
    expect(output).toContain("show");
    expect(output).toContain("resume");
  });

  test("prints an install script for completion bash without services", async () => {
    const streams = createRecordingCliStreams();
    const code = await dispatch({
      argv: ["completion", "bash"],
      streams,
      services: () => {
        throw new Error("completion install must not construct services");
      },
    });
    expect(code).toBe(EXIT_CODES.COMPLETED);
    expect(streams.resultWrites().join("")).toContain("###-begin-falryn-completions-###");
    expect(streams.diagnosticWrites()).toEqual([]);
  });

  test("detects runtime completion requests", () => {
    expect(isCompletionRequest(["--get-yargs-completions", "doctor"])).toBe(true);
    expect(isCompletionRequest(["completion", "bash"])).toBe(false);
  });
});
