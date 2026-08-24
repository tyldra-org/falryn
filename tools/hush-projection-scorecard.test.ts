import { describe, expect, test } from "bun:test";

import {
  HUSH_FIND_LISTING_PATHS,
  HUSH_PROJECTION_CASES,
  HUSH_PROJECTION_CORPUS_VERSION,
} from "./hush-projection-scorecard.ts";

describe("Hush projection scorecard corpus", () => {
  test("keeps each supported Git mutation as a separate RTK comparison", () => {
    expect(HUSH_PROJECTION_CORPUS_VERSION).toBe("hush-projections.v12");
    expect(
      HUSH_PROJECTION_CASES.filter((entry) => entry.projection === "git-mutation").map(
        (entry) => entry.id,
      ),
    ).toEqual(["git-add", "git-commit", "git-push", "git-pull"]);
  });

  test("compares Git and external unified diffs independently", () => {
    const diffs = HUSH_PROJECTION_CASES.filter((entry) => entry.projection === "git-diff");
    expect(diffs.map((entry) => entry.id)).toEqual(["git-diff", "external-diff"]);
    const external = HUSH_PROJECTION_CASES.find((entry) => entry.id === "external-diff");
    expect(external?.acceptedExitCodes).toEqual([1]);
    expect(external?.forbiddenMarkers).toContain("omitted");
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

  test("compares journalctl with RTK log while requiring every event fact", () => {
    const logs = HUSH_PROJECTION_CASES.filter((entry) => entry.projection === "log");
    expect(logs.map((entry) => entry.id)).toEqual(["log-docker", "log-journalctl"]);
    const journal = HUSH_PROJECTION_CASES.find((entry) => entry.id === "log-journalctl");
    expect(journal?.baseline).toBe("rtk-log");
    expect(journal?.requiredMarkers).toHaveLength(7);
    expect(journal?.forbiddenMarkers).toContain("omitted");
  });

  test("compares single and multi-file wc without dropping count facts", () => {
    const counts = HUSH_PROJECTION_CASES.filter((entry) => entry.projection === "count");
    expect(counts.map((entry) => entry.id)).toEqual(["count-wc-single", "count-wc-multi"]);
    expect(counts.every((entry) => entry.requiredMarkers.length >= 3)).toBe(true);
    expect(counts.every((entry) => entry.forbiddenMarkers?.includes("omitted"))).toBe(true);
  });

  test("compares complete PostgreSQL tables through the pinned RTK reducer", () => {
    const psql = HUSH_PROJECTION_CASES.filter((entry) => entry.executable === "psql");
    expect(psql.map((entry) => entry.id)).toEqual(["data-psql-table", "data-psql-expanded"]);
    expect(psql.every((entry) => entry.projection === "structured")).toBe(true);
    expect(psql.every((entry) => entry.rtkArgv?.[0] === "psql")).toBe(true);
    expect(psql.every((entry) => entry.forbiddenMarkers?.includes("omitted"))).toBe(true);
  });

  test("compares SQLite human display modes through RTK passthrough", () => {
    const sqlite = HUSH_PROJECTION_CASES.filter((entry) => entry.executable === "sqlite3");
    expect(sqlite.map((entry) => entry.id)).toEqual([
      "data-sqlite-column",
      "data-sqlite-box",
      "data-sqlite-line",
    ]);
    expect(sqlite.every((entry) => entry.projection === "structured")).toBe(true);
    expect(sqlite.every((entry) => entry.rtkArgv?.[0] === "sqlite3")).toBe(true);
    expect(sqlite.every((entry) => entry.forbiddenMarkers?.includes("omitted"))).toBe(true);
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
