import { describe, expect, test } from "bun:test";

import {
  HUSH_FIND_LISTING_PATHS,
  HUSH_PROJECTION_CASES,
  HUSH_PROJECTION_CORPUS_VERSION,
} from "./hush-projection-scorecard.ts";

describe("Hush projection scorecard corpus", () => {
  test("keeps each supported Git mutation as a separate RTK comparison", () => {
    expect(HUSH_PROJECTION_CORPUS_VERSION).toBe("hush-projections.v19");
    expect(
      HUSH_PROJECTION_CASES.filter((entry) => entry.projection === "git-mutation").map(
        (entry) => entry.id,
      ),
    ).toEqual([
      "git-add",
      "git-branch",
      "git-checkout",
      "git-commit",
      "git-fetch",
      "git-push",
      "git-pull",
      "git-stash",
      "git-worktree",
    ]);
  });

  test("compares Git and external unified diffs independently", () => {
    const diffs = HUSH_PROJECTION_CASES.filter((entry) => entry.projection === "git-diff");
    expect(diffs.map((entry) => entry.id)).toEqual([
      "git-diff",
      "git-diff-stat",
      "git-diff-name-status",
      "git-diff-large-complete",
      "external-diff",
    ]);
    const git = HUSH_PROJECTION_CASES.find((entry) => entry.id === "git-diff");
    expect(git?.requiredMarkers).toHaveLength(14);
    expect(git?.forbiddenMarkers).toContain("--- a/");
    expect(git?.forbiddenMarkers).toContain("omitted");
    const large = HUSH_PROJECTION_CASES.find((entry) => entry.id === "git-diff-large-complete");
    expect(large?.rtkArgv).toContain("--no-compact");
    expect(large?.requiredMarkers).toContain("-before-80");
    expect(large?.requiredMarkers).toContain("+after-80");
    const external = HUSH_PROJECTION_CASES.find((entry) => entry.id === "external-diff");
    expect(external?.acceptedExitCodes).toEqual([1]);
    expect(external?.forbiddenMarkers).toContain("omitted");
  });

  test("compares uncapped Git log and complete Git show projections independently", () => {
    const history = HUSH_PROJECTION_CASES.filter((entry) => entry.projection === "git-log");
    expect(history.map((entry) => entry.id)).toEqual(["git-log", "git-show"]);
    const log = HUSH_PROJECTION_CASES.find((entry) => entry.id === "git-log");
    expect(log?.argv).toContain("-3");
    expect(log?.requiredMarkers).toContain(
      "33333333 2026-08-24 Review Agent | Keep the final commit",
    );
    expect(log?.forbiddenMarkers).toContain("omitted");
    const show = HUSH_PROJECTION_CASES.find((entry) => entry.id === "git-show");
    expect(show?.requiredMarkers).toHaveLength(16);
    expect(show?.requiredMarkers).toContain("export const reducer = 'git.show'");
    expect(show?.forbiddenMarkers).toContain("--- a/");
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
    ).toEqual([
      "gh-pr-list",
      "gh-pr-view",
      "gh-issue-list",
      "gh-run-list",
      "gh-repo-view",
      "gh-api",
      "gh-release-list",
    ]);
    const issueList = HUSH_PROJECTION_CASES.find((entry) => entry.id === "gh-issue-list");
    expect(issueList?.argv).toEqual(["issue", "list", "--limit", "20"]);
    expect(issueList?.requiredMarkers).toContain(
      "790 Implement registry-driven slash completion and command aliases",
    );
    const runList = HUSH_PROJECTION_CASES.find((entry) => entry.id === "gh-run-list");
    expect(runList?.argv).toEqual(["run", "list", "--limit", "10"]);
    expect(runList?.requiredMarkers).toContain("cancel 32606 32607");
  });

  test("keeps each requested GitLab command as a separate RTK comparison", () => {
    expect(
      HUSH_PROJECTION_CASES.filter((entry) => entry.executable === "glab").map((entry) => entry.id),
    ).toEqual([
      "glab-mr-list",
      "glab-issue-list",
      "glab-ci-status",
      "glab-pipeline-list",
      "glab-api",
      "glab-release-list",
    ]);
    expect(
      HUSH_PROJECTION_CASES.filter((entry) => entry.executable === "glab").every((entry) =>
        entry.forbiddenMarkers?.includes("omitted"),
      ),
    ).toBe(true);
    expect(HUSH_PROJECTION_CASES.find((entry) => entry.id === "glab-pipeline-list")?.baseline).toBe(
      "raw",
    );
  });

  test("keeps each requested Graphite command as a separate RTK comparison", () => {
    expect(
      HUSH_PROJECTION_CASES.filter((entry) => entry.executable === "gt").map((entry) => entry.id),
    ).toEqual(["gt-log", "gt-submit", "gt-sync", "gt-restack", "gt-create", "gt-branch"]);
    expect(
      HUSH_PROJECTION_CASES.filter((entry) => entry.executable === "gt").every((entry) =>
        entry.forbiddenMarkers?.includes("omitted"),
      ),
    ).toBe(true);
    expect(
      HUSH_PROJECTION_CASES.filter((entry) =>
        ["gt-sync", "gt-restack", "gt-create"].includes(entry.id),
      ).every((entry) => "baseline" in entry && entry.baseline === "raw"),
    ).toBe(true);
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

  test("compares every supported system table command without accepting missing facts", () => {
    const system = HUSH_PROJECTION_CASES.filter((entry) =>
      ["df", "du", "ps", "stat", "systemctl"].includes(entry.executable),
    );
    expect(system.map((entry) => entry.id)).toEqual([
      "system-df",
      "system-du",
      "system-ps",
      "system-stat",
      "system-systemctl",
    ]);
    expect(system.every((entry) => entry.projection === "table")).toBe(true);
    expect(
      system.every((entry) => "rtkArgv" in entry && entry.rtkArgv[0] === entry.executable),
    ).toBe(true);
    expect(
      system.every(
        (entry) =>
          "forbiddenMarkers" in entry &&
          (entry.forbiddenMarkers as readonly string[]).includes("omitted"),
      ),
    ).toBe(true);
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
