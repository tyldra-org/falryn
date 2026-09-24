import { describe, expect, test } from "bun:test";
import { carriesRoadmapField, liveIssueFromGraphQl } from "./issue-readiness-cli.ts";

function liveIssue(overrides: Record<string, unknown> = {}) {
  return {
    number: 7,
    title: "t",
    body: "",
    state: "OPEN",
    updatedAt: "2026-09-01T00:00:00.000Z",
    milestone: { title: "v0.4 Extensions and Collaboration" },
    assignees: { totalCount: 0, nodes: [] },
    labels: { totalCount: 0, nodes: [] },
    parent: null,
    subIssues: { totalCount: 0, nodes: [] },
    blockedBy: { totalCount: 0, nodes: [] },
    issueFieldValues: {
      totalCount: 2,
      nodes: [{ field: { name: "Readiness" } }, { field: { name: "Priority" } }],
    },
    ...overrides,
  };
}

describe("issue readiness Roadmap capture", () => {
  test("reads the release milestone and Roadmap membership from the issue", () => {
    expect(liveIssueFromGraphQl(liveIssue())).toMatchObject({
      targetRelease: "v0.4 Extensions and Collaboration",
      roadmap: true,
    });
    expect(liveIssueFromGraphQl(liveIssue({ milestone: null }))).toMatchObject({
      targetRelease: null,
    });
  });

  test("treats only Roadmap planning fields as membership", () => {
    expect(
      carriesRoadmapField({ totalCount: 1, nodes: [{ field: { name: "Priority" } }] }, "values"),
    ).toBe(false);
    expect(
      carriesRoadmapField(
        { totalCount: 1, nodes: [{ field: { name: "Roadmap priority" } }] },
        "values",
      ),
    ).toBe(true);
    expect(
      carriesRoadmapField(
        { totalCount: 1, nodes: [{ field: { name: "Release exception" } }] },
        "values",
      ),
    ).toBe(true);
  });

  test("refuses a truncated field-value connection", () => {
    expect(() => carriesRoadmapField({ totalCount: 31, nodes: [] }, "values")).toThrow("values");
  });
});
