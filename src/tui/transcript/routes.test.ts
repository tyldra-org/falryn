/**
 * The control that keeps an expansion route from being a phrase nobody
 * dispatches.
 *
 * The projections contract says a route is a promise the running build has to
 * keep. This walks the whole union against the real registry, so a route added
 * without a command fails here rather than reaching a user as an offer that
 * does nothing.
 */

import { describe, expect, test } from "bun:test";
import { EXPANSION_ROUTES } from "../../presentation/index.ts";
import { commandById, EMPTY_COMMAND_STATE } from "../commands.ts";
import { commandRows } from "../keymap.ts";
import { commandForRoute, describeRouteWith } from "./routes.ts";

function rows() {
  return commandRows(
    { ...EMPTY_COMMAND_STATE, hasTranscript: true },
    new Set(["transcript.expand"]),
  );
}

describe("every expansion route", () => {
  test("resolves to a command the registry actually declares", () => {
    // The load-bearing assertion of this file.
    for (const route of EXPANSION_ROUTES) {
      const id = commandForRoute(route);
      expect({ route, declared: commandById(id) !== undefined }).toEqual({
        route,
        declared: true,
      });
    }
  });

  test("resolves to a distinct command", () => {
    // Two routes on one command would make "open the artifact" and "show the
    // diagnostics" the same action, which is a contract that reads as richer
    // than the build is.
    const ids = EXPANSION_ROUTES.map(commandForRoute);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("is described in a sentence a reader can act on", () => {
    for (const route of EXPANSION_ROUTES) {
      const described = describeRouteWith(rows(), route);
      expect({ route, empty: described.trim() === "" }).toEqual({ route, empty: false });
      expect({ route, unnamed: described.includes("undefined") }).toEqual({
        route,
        unnamed: false,
      });
    }
  });
});

describe("a route whose command cannot run", () => {
  test("says why instead of offering a key", () => {
    // There is no artifact viewer in this build. Offering a key for one would be
    // the promise this whole mechanism exists to avoid.
    const described = describeRouteWith(rows(), "transcript.open-artifact");
    expect(described).toContain("unavailable");
    expect(described).toContain("no artifact viewer yet");
  });

  test("names the diagnostics route's own reason rather than a shared one", () => {
    const described = describeRouteWith(rows(), "transcript.show-diagnostics");
    expect(described).toContain("no diagnostics view yet");
  });
});

describe("a route whose command runs", () => {
  test("names the key that runs it right now", () => {
    // Resolved through the live plan, so the sentence tracks a rebinding rather
    // than repeating a key somebody wrote into a string. `return` rather than
    // `enter` because that is the key parser's canonical name, and a binding
    // declared under any other one never fires.
    expect(describeRouteWith(rows(), "transcript.expand")).toContain("return");
  });

  test("falls back to the command's name when it has no key", () => {
    const described = describeRouteWith(
      [
        {
          id: "transcript.expand",
          title: "Expand",
          description: "",
          binding: null,
          unavailableReason: null,
        },
      ],
      "transcript.expand",
    );
    expect(described).toBe("Run Expand.");
  });
});

describe("rows that do not contain the command", () => {
  test("produce a sentence naming what is missing rather than silence", () => {
    expect(describeRouteWith([], "transcript.expand")).toContain("transcript.expand");
  });
});
