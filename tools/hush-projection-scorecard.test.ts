import { describe, expect, test } from "bun:test";

import {
  HUSH_FIND_LISTING_PATHS,
  HUSH_PROJECTION_CASES,
  HUSH_PROJECTION_CORPUS_VERSION,
} from "./hush-projection-scorecard.ts";

describe("Hush projection scorecard corpus", () => {
  test("keeps each supported Git mutation as a separate RTK comparison", () => {
    expect(HUSH_PROJECTION_CORPUS_VERSION).toBe("hush-projections.v6");
    expect(
      HUSH_PROJECTION_CASES.filter((entry) => entry.projection === "git-mutation").map(
        (entry) => entry.id,
      ),
    ).toEqual(["git-add", "git-commit", "git-push", "git-pull"]);
  });

  test("locks the large find listing that exposed RTK path omission", () => {
    const listing = HUSH_PROJECTION_CASES[0];
    expect(listing.id).toBe("listing-find");
    expect(HUSH_FIND_LISTING_PATHS).toHaveLength(67);
    expect(listing.requiredMarkers).toHaveLength(18);
    expect(listing.forbiddenMarkers).toContain("+17 more");
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
