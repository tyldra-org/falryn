import { describe, expect, test } from "bun:test";
import { roadmapItemFields, roadmapMembershipForIssue } from "./issue-readiness-cli.ts";

function itemNode(id: string, projectId: string, status: string, release: string) {
  return {
    id,
    project: { id: projectId },
    fieldValues: {
      totalCount: 3,
      nodes: [
        { name: status, field: { name: "Status" } },
        { name: release, field: { name: "Target release" } },
        { name: "P2", field: { name: "Priority" } },
      ],
    },
  };
}

describe("issue readiness Roadmap membership capture", () => {
  test("reads Status and Target release from one item", () => {
    expect(roadmapItemFields(itemNode("item", "project-1", "Todo", "Release A"), "item")).toEqual({
      id: "item",
      statuses: ["Todo"],
      targetReleases: ["Release A"],
    });
  });

  test("recovers the audited Project's item when the list omits it", () => {
    const issueSide = {
      totalCount: 2,
      nodes: [
        itemNode("roadmap-item", "project-1", "Todo", "Release A"),
        itemNode("other-item", "project-9", "Done", "Release Z"),
      ],
    };
    expect(roadmapMembershipForIssue([], issueSide, "project-1", "issue")).toEqual({
      itemCount: 1,
      statuses: ["Todo"],
      targetReleases: ["Release A"],
      recovered: 1,
    });
  });

  test("prefers the issue-side value and retains list-only items", () => {
    const listed = [
      { id: "shared", statuses: ["Todo"], targetReleases: ["Release A"] },
      { id: "listed-only", statuses: ["Todo"], targetReleases: ["Release A"] },
    ];
    const issueSide = {
      totalCount: 1,
      nodes: [itemNode("shared", "project-1", "In Progress", "Release B")],
    };
    expect(roadmapMembershipForIssue(listed, issueSide, "project-1", "issue")).toEqual({
      itemCount: 2,
      statuses: ["In Progress", "Todo"],
      targetReleases: ["Release B", "Release A"],
      recovered: 0,
    });
  });

  test("keeps a real gap absent and refuses a truncated issue-side connection", () => {
    expect(
      roadmapMembershipForIssue([], { totalCount: 0, nodes: [] }, "project-1", "issue"),
    ).toEqual({ itemCount: 0, statuses: [], targetReleases: [], recovered: 0 });
    expect(() =>
      roadmapMembershipForIssue([], { totalCount: 11, nodes: [] }, "project-1", "issue"),
    ).toThrow("issue");
  });
});
