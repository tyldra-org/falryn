import { describe, expect, test } from "bun:test";

import {
  HUSH_PROJECTION_CASES,
  HUSH_PROJECTION_CORPUS_VERSION,
} from "./hush-projection-scorecard.ts";

describe("Hush projection scorecard corpus", () => {
  test("keeps each supported Git mutation as a separate RTK comparison", () => {
    expect(HUSH_PROJECTION_CORPUS_VERSION).toBe("hush-projections.v5");
    expect(
      HUSH_PROJECTION_CASES.filter((entry) => entry.projection === "git-mutation").map(
        (entry) => entry.id,
      ),
    ).toEqual(["git-add", "git-commit", "git-push", "git-pull"]);
  });

  test("keeps each supported GitHub read as a separate RTK comparison", () => {
    expect(
      HUSH_PROJECTION_CASES.filter((entry) => entry.executable === "gh").map((entry) => entry.id),
    ).toEqual(["gh-pr-list", "gh-pr-view", "gh-issue-list", "gh-run-list"]);
  });

  test("covers ripgrep, sed, pipelines, and and-chains independently", () => {
    expect(
      HUSH_PROJECTION_CASES.filter((entry) =>
        [
          "search-rg",
          "transform-sed",
          "compound-rg-sed-pipe",
          "compound-pipe-rg",
          "compound-rg-and-sed",
        ].includes(entry.id),
      ).map((entry) => entry.id),
    ).toEqual([
      "search-rg",
      "transform-sed",
      "compound-rg-sed-pipe",
      "compound-pipe-rg",
      "compound-rg-and-sed",
    ]);
  });
});
