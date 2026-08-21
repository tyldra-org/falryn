import { describe, expect, test } from "bun:test";
import {
  SESSION_NAV_PANEL_TITLES,
  sessionNavOverlayRoute,
  sessionNavPanelForCommand,
} from "./format.ts";

describe("sessionNavOverlayRoute", () => {
  test("names the panel and carries session and draft", () => {
    expect(sessionNavOverlayRoute("rewind", "session-a", "turn-1")).toEqual({
      kind: "session-nav",
      panel: "rewind",
      sessionId: "session-a",
      draft: "turn-1",
    });
  });
});

describe("sessionNavPanelForCommand", () => {
  test("maps registry ids to panels", () => {
    expect(sessionNavPanelForCommand("session.resume")).toBe("resume");
    expect(sessionNavPanelForCommand("session.replay")).toBe("replay");
    expect(sessionNavPanelForCommand("session.new")).toBeNull();
  });
});

describe("SESSION_NAV_PANEL_TITLES", () => {
  test("labels replay explicitly", () => {
    expect(SESSION_NAV_PANEL_TITLES.replay).toContain("Replay");
  });
});
