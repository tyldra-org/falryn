import { describe, expect, test } from "bun:test";

import { duration } from "../clock.ts";
import type { ProcessCaptureRequest } from "../process-capture.ts";
import { commandShape } from "./command-shape.ts";
import { parseShellCommand } from "./shell-command.ts";

describe("Hush shell command parsing", () => {
  test("segments pipelines and and-chains without splitting quoted operators", () => {
    expect(parseShellCommand("rg 'a|b && c' src | sed -n '1,20p' file")).toEqual({
      commands: [
        ["rg", "a|b && c", "src"],
        ["sed", "-n", "1,20p", "file"],
      ],
      operators: ["pipe"],
      opaque: false,
    });
    expect(parseShellCommand("rg marker src && sed -n '1,20p' file")).toEqual({
      commands: [
        ["rg", "marker", "src"],
        ["sed", "-n", "1,20p", "file"],
      ],
      operators: ["and"],
      opaque: false,
    });
  });

  test("keeps stderr pipes distinct and ignores redirection operands", () => {
    expect(parseShellCommand("cargo test 2>&1 |& rg FAILED")).toEqual({
      commands: [
        ["cargo", "test"],
        ["rg", "FAILED"],
      ],
      operators: ["stderr-pipe"],
      opaque: false,
    });
    expect(parseShellCommand("rg marker src &")).toEqual({
      commands: [["rg", "marker", "src"]],
      operators: ["background"],
      opaque: false,
    });
  });

  test("marks substitutions, groups, malformed stages, and unterminated quotes opaque", () => {
    expect(parseShellCommand("echo $(rg marker src)").opaque).toBe(true);
    expect(parseShellCommand("diff <(sed -n '1p' before) <(sed -n '1p' after)").opaque).toBe(true);
    expect(parseShellCommand("(rg marker src) | sed -n '1p'").opaque).toBe(true);
    expect(parseShellCommand("rg marker src | | sed -n '1p'").opaque).toBe(true);
    expect(parseShellCommand("rg marker src &&").opaque).toBe(true);
    expect(parseShellCommand("rg 'marker src").opaque).toBe(true);
  });

  test("normalizes every parsed command stage", () => {
    const shape = commandShape(bash("FOO=1 sudo rg marker src | sed -n '1,20p'"));
    expect(shape.tokens).toEqual(["rg", "marker", "src"]);
    expect(shape.commands).toEqual([
      ["rg", "marker", "src"],
      ["sed", "-n", "1,20p"],
    ]);
    expect(shape.operators).toEqual(["pipe"]);
    expect(shape.compound).toBe(true);
    expect(shape.opaque).toBe(false);
  });
});

function bash(command: string): ProcessCaptureRequest {
  return {
    mode: "bash",
    executable: "/bin/bash",
    command,
    environment: {},
    timeoutMs: duration(5_000),
    maxOutputBytes: 64 * 1_024,
  };
}
