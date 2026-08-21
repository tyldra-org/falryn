import { describe, expect, test } from "bun:test";

import { taskIntelligenceOverlayRoute, taskIntelligencePanelForCommand } from "./format.ts";

describe("taskIntelligenceOverlayRoute", () => {
  test("opens a decompose sheet with a starter draft", () => {
    expect(taskIntelligenceOverlayRoute("decompose")).toEqual({
      kind: "task-intelligence",
      panel: "decompose",
      draft: expect.stringContaining("statement="),
    });
  });
});

describe("taskIntelligencePanelForCommand", () => {
  test("maps shell command ids to panels", () => {
    expect(taskIntelligencePanelForCommand("task.decompose")).toBe("decompose");
    expect(taskIntelligencePanelForCommand("task.validate")).toBe("validate");
    expect(taskIntelligencePanelForCommand("task.progress")).toBe("progress");
    expect(taskIntelligencePanelForCommand("task.commit-plan")).toBe("commit-plan");
    expect(taskIntelligencePanelForCommand("app.help")).toBeNull();
  });
});
