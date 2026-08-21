/**
 * The `falryn task decompose|validate|progress` command surface.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { parseInvocation } from "./command-tree.ts";
import {
  runTaskDecompose,
  runTaskProgress,
  runTaskValidate,
} from "./task-intelligence-commands.ts";
import { taskArgumentsFor } from "./task-intelligence-parse.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "task-intelligence");

async function commandOf(...argv: string[]): Promise<string> {
  const invocation = await parseInvocation(argv);
  return invocation.kind === "run" ? invocation.command : invocation.kind;
}

describe("task intelligence commands", () => {
  test("routes decompose, validate, and progress through the tree", async () => {
    expect(await commandOf("task", "decompose", "--statement", "Ship", "--goal", "Write")).toBe(
      "task.decompose",
    );
    expect(await commandOf("task", "validate", "--task", "t1:Restore succeeds")).toBe(
      "task.validate",
    );
    expect(await commandOf("task", "progress", "--task", "t1", "--task", "t2")).toBe(
      "task.progress",
    );
  });

  test("decomposes declared goals from explicit flags", async () => {
    const args = await taskArgumentsFor("decompose", {
      statement: "Ship a bounded export.",
      goal: ["Write the export package"],
      "non-goal": ["Execute Git"],
    });
    expect(typeof args).not.toBe("string");
    if (typeof args === "string" || args.action !== "decompose") {
      return;
    }
    const result = runTaskDecompose(args);
    expect(result.outcome).toEqual({ kind: "completed" });
    expect(result.payload?.decomposition.tasks).toHaveLength(1);
  });

  test("loads bounded decompose input from JSON", async () => {
    const args = await taskArgumentsFor("decompose", {
      input: join(FIXTURES, "decompose.json"),
    });
    expect(typeof args).not.toBe("string");
    if (typeof args === "string" || args.action !== "decompose") {
      return;
    }
    const result = runTaskDecompose(args);
    expect(result.payload?.decomposition.tasks).toHaveLength(2);
  });

  test("recommends validation advice for declared criteria", async () => {
    const args = await taskArgumentsFor("validate", {
      task: ["t1:Restore succeeds from the package"],
    });
    expect(typeof args).not.toBe("string");
    if (typeof args === "string" || args.action !== "validate") {
      return;
    }
    const result = runTaskValidate(args);
    expect(result.payload?.advice.recommendations).toHaveLength(2);
  });

  test("projects progress from explicit observations", async () => {
    const args = await taskArgumentsFor("progress", {
      task: ["t1", "t2"],
      depends: ["t1:t2"],
      observe: ["t1:completed"],
    });
    expect(typeof args).not.toBe("string");
    if (typeof args === "string" || args.action !== "progress") {
      return;
    }
    const result = runTaskProgress(args);
    expect(result.payload?.projection.overall).toBe("partial");
    expect(result.payload?.projection.nextActions).toHaveLength(1);
  });

  test("refuses secret-shaped criteria without echoing them", async () => {
    const args = await taskArgumentsFor("validate", {
      task: ["t1:token sk-live-SECRET must remain"],
    });
    expect(typeof args).not.toBe("string");
    if (typeof args === "string" || args.action !== "validate") {
      return;
    }
    const result = runTaskValidate(args);
    expect(result.outcome).toEqual({ kind: "failed", effect: "none" });
    expect(JSON.stringify(result)).not.toContain("sk-live-SECRET");
  });
});
