import { describe, expect, test } from "bun:test";

import {
  decomposeArgumentsFromDraft,
  progressArgumentsFromDraft,
  validateArgumentsFromDraft,
} from "./task-intelligence-parse.ts";

describe("task intelligence draft parsing", () => {
  test("parses decompose drafts", () => {
    const parsed = decomposeArgumentsFromDraft(
      "statement=Ship export\ngoal=Write the export package",
    );
    expect(typeof parsed).not.toBe("string");
    if (typeof parsed === "string") {
      return;
    }
    expect(parsed.goals).toEqual(["Write the export package"]);
  });

  test("parses validate drafts", () => {
    const parsed = validateArgumentsFromDraft("task=t1:Restore succeeds");
    expect(typeof parsed).not.toBe("string");
    if (typeof parsed === "string") {
      return;
    }
    expect(parsed.tasks[0]?.criteria).toEqual(["Restore succeeds"]);
  });

  test("parses progress drafts", () => {
    const parsed = progressArgumentsFromDraft(
      "task=t1\ntask=t2\ndepends=t1:t2\nobserve=t1:completed",
    );
    expect(typeof parsed).not.toBe("string");
    if (typeof parsed === "string") {
      return;
    }
    expect(parsed.tasks).toEqual(["t1", "t2"]);
    expect(parsed.observations[0]?.status).toBe("completed");
  });
});
