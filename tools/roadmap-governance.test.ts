import { describe, expect, test } from "bun:test";
import {
  analyzeRoadmapGovernance,
  parseRoadmapGovernanceSnapshot,
  type RoadmapGovernanceIssue,
  type RoadmapGovernanceSnapshot,
} from "./roadmap-governance";
import {
  assertAllProjectIssueItemsConsumed,
  fieldValues,
  parseCli,
} from "./roadmap-governance-cli";

const REPOSITORY = "tyldra-org/falryn";

function projectItem(
  overrides: Partial<RoadmapGovernanceIssue["projectItems"][number]> = {},
): RoadmapGovernanceIssue["projectItems"][number] {
  return {
    id: "item-1",
    status: "Todo",
    statusUpdatedAt: "2026-09-01T00:00:00.000Z",
    priority: "P2",
    readiness: "Not Ready",
    ...overrides,
  };
}

function issue(overrides: Partial<RoadmapGovernanceIssue> = {}): RoadmapGovernanceIssue {
  return {
    repository: REPOSITORY,
    number: 1,
    title: "Implement bounded behavior",
    body: `## Outcome

Deliver bounded behavior.

## Relationship

Planning relationship: Standalone-v1.

## Ready checklist

- [ ] Verify the source baseline.
`,
    state: "OPEN",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    closedAt: null,
    assignees: ["owner"],
    labels: ["type: infrastructure", "area: docs"],
    milestone: "v0.4 Extensions and Collaboration",
    milestoneState: "OPEN",
    parent: null,
    subIssues: [],
    blockedBy: [],
    closingPullRequests: [],
    projectItems: [projectItem()],
    ...overrides,
  };
}

function snapshot(issues: readonly RoadmapGovernanceIssue[]): RoadmapGovernanceSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: "2026-09-03T00:00:00.000Z",
    projectOwner: "tyldra-org",
    projectNumber: 1,
    projectId: "project-1",
    repositories: [REPOSITORY, "tyldra-org/falryn-docs"],
    repositoryIssueCounts: [
      {
        repository: REPOSITORY,
        count: issues.filter((entry) => entry.repository === REPOSITORY).length,
      },
      {
        repository: "tyldra-org/falryn-docs",
        count: issues.filter((entry) => entry.repository === "tyldra-org/falryn-docs").length,
      },
    ],
    statusOptions: ["Todo", "In Progress", "Done"],
    priorityOptions: ["P0", "P1", "P2", "P3", "Historical"],
    readinessOptions: ["Ready", "Not Ready", "Parent", "Historical"],
    issues,
    nonIssueProjectItems: [],
  };
}

function codes(input: RoadmapGovernanceSnapshot): readonly string[] {
  return analyzeRoadmapGovernance(input).diagnostics.map((diagnostic) => diagnostic.code);
}

describe("roadmap governance CLI validation", () => {
  test("rejects partial live repository selection", () => {
    expect(() =>
      parseCli(["--live", REPOSITORY, "--project-owner", "tyldra-org", "--project-number", "1"]),
    ).toThrow("live audit requires exactly");
  });

  test("rejects Project issues outside the canonical repository audit", () => {
    const projectItems = new Map([
      ["canonical-node", [projectItem()]],
      ["outside-node", [projectItem({ id: "outside-item" })]],
    ]);
    expect(() =>
      assertAllProjectIssueItemsConsumed(projectItems, new Set(["canonical-node"])),
    ).toThrow("1 issue item(s) outside the canonical repository audit");
  });

  test("rejects duplicate Project field names on an item", () => {
    const value = {
      totalCount: 2,
      nodes: [
        { name: "Todo", field: { id: "field-1", name: "Status" } },
        { name: "Todo", field: { id: "field-2", name: "Status" } },
      ],
    };
    expect(() => fieldValues(value, "fieldValues")).toThrow(
      "fieldValues contains duplicate field name Status",
    );
  });
});

describe("parseRoadmapGovernanceSnapshot", () => {
  test("round-trips a valid snapshot", () => {
    const input = snapshot([issue()]);
    expect(parseRoadmapGovernanceSnapshot(JSON.parse(JSON.stringify(input)))).toEqual(input);
  });

  test("rejects duplicate repository-qualified issue identities", () => {
    const input = snapshot([issue(), issue()]);
    expect(() => parseRoadmapGovernanceSnapshot(input)).toThrow(
      "duplicate issue identity: tyldra-org/falryn#1",
    );
  });

  test("permits equal issue numbers in different repositories", () => {
    const input = snapshot([
      issue(),
      issue({ repository: "tyldra-org/falryn-docs", title: "Document bounded behavior" }),
    ]);
    expect(parseRoadmapGovernanceSnapshot(input).issues).toHaveLength(2);
  });

  test("rejects semantically invalid snapshot scope, state, and timestamps", () => {
    const invalidBody = JSON.parse(JSON.stringify(snapshot([issue()]))) as {
      issues: Array<{ body: unknown }>;
    };
    if (invalidBody.issues[0] !== undefined) {
      invalidBody.issues[0].body = null;
    }
    expect(() => parseRoadmapGovernanceSnapshot(invalidBody)).toThrow(
      "issues[0].body must be a string",
    );

    const reversedScope = {
      ...snapshot([issue()]),
      repositories: ["tyldra-org/falryn-docs", REPOSITORY],
    };
    expect(() => parseRoadmapGovernanceSnapshot(reversedScope)).toThrow(
      "snapshot.repositories must be exactly",
    );
    expect(() =>
      parseRoadmapGovernanceSnapshot(snapshot([issue({ repository: "external/example" })])),
    ).toThrow("issue repository is outside snapshot.repositories");
    expect(() =>
      parseRoadmapGovernanceSnapshot(snapshot([issue({ closedAt: "2026-09-02T00:00:00Z" })])),
    ).toThrow("state and closedAt disagree");
    expect(() =>
      parseRoadmapGovernanceSnapshot(snapshot([issue({ updatedAt: "not-a-timestamp" })])),
    ).toThrow("must be an ISO 8601 timestamp with timezone");
    const incomplete = snapshot([issue(), issue({ number: 2 })]);
    expect(() =>
      parseRoadmapGovernanceSnapshot({ ...incomplete, issues: incomplete.issues.slice(0, 1) }),
    ).toThrow("snapshot issue count mismatch");
    expect(() =>
      parseRoadmapGovernanceSnapshot(
        snapshot([
          issue({
            state: "CLOSED",
            updatedAt: "2026-09-01T00:00:00.000Z",
            closedAt: "2026-09-02T00:00:00.000Z",
          }),
        ]),
      ),
    ).toThrow("closedAt follows updatedAt");
    expect(() =>
      parseRoadmapGovernanceSnapshot(
        snapshot([
          issue({
            state: "CLOSED",
            updatedAt: "2026-09-02T00:00:00.000Z",
            closedAt: "2026-09-02T00:00:00.000Z",
            projectItems: [
              projectItem({
                status: "Done",
                statusUpdatedAt: "2026-09-01T12:00:00.000Z",
                readiness: "Historical",
              }),
            ],
          }),
        ]),
      ),
    ).toThrow("Done precedes closedAt");
    expect(() =>
      parseRoadmapGovernanceSnapshot({
        ...snapshot([issue()]),
        generatedAt: "2026-08-31T00:00:00.000Z",
      }),
    ).toThrow("follows generatedAt");
  });
});

describe("analyzeRoadmapGovernance", () => {
  test("accepts explicit open and historical classifications", () => {
    const closed = issue({
      number: 2,
      title: "Delivered behavior",
      state: "CLOSED",
      closedAt: "2026-09-02T00:00:00.000Z",
      projectItems: [
        projectItem({
          id: "item-2",
          status: "Done",
          priority: "Historical",
          readiness: "Historical",
        }),
      ],
    });
    expect(analyzeRoadmapGovernance(snapshot([issue(), closed])).diagnostics).toEqual([]);
  });

  test("requires complete Project field schemas", () => {
    const input = {
      ...snapshot([issue()]),
      statusOptions: ["Todo"],
      priorityOptions: ["P0", "P1", "P2", "P3"],
      readinessOptions: [],
    };
    expect(codes(input)).toEqual([
      "priority-field-invalid",
      "readiness-field-invalid",
      "status-field-invalid",
    ]);
  });

  test("rejects non-issue Project items", () => {
    const value = snapshot([issue()]);
    expect(
      codes({
        ...value,
        nonIssueProjectItems: [{ id: "project-item-pr", contentKind: "PULL_REQUEST" }],
      }),
    ).toEqual(["non-issue-project-item"]);
  });

  test("requires one Project item and valid classifications", () => {
    const missing = issue({ projectItems: [] });
    const invalid = issue({
      number: 2,
      projectItems: [
        projectItem({
          id: "item-2",
          status: "Done",
          priority: "Historical",
          readiness: "Historical",
        }),
      ],
    });
    expect(codes(snapshot([missing, invalid]))).toEqual([
      "project-membership-count",
      "open-historical-priority",
      "readiness-invalid",
      "status-invalid",
    ]);
  });

  test("rejects noncanonical or negated Standalone relationship text", () => {
    for (const declaration of [
      "Standalone is not the issue relationship.",
      "Standalone isn't the issue relationship.",
      "Standalone does not apply.",
      "Standalone: not applicable.",
      "Standalone cannot apply.",
      "Standalone no longer applies.",
      "Standalone is no longer applicable.",
      "Standalone should not apply.",
      "Standalone must not apply.",
      "Standalone no.",
      "Standalone false.",
      "Standalone work is not the issue relationship.",
      "Standalone-v1.",
      "Delivery role: Standalone-v1.",
      "standalone",
      "-Standalone",
    ]) {
      const input = issue({
        body: `## Outcome\n\nDeliver bounded behavior.\n\n## Relationship\n\n${declaration}\n`,
      });
      const report = analyzeRoadmapGovernance(snapshot([input]));
      expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        "planning-relationship-missing",
      ]);
      expect(report.deliverySequence).toEqual([]);
    }
    const affirmative = issue({
      body: "## Outcome\n\nDeliver bounded behavior.\n\n## Relationship\n\nPlanning relationship: Standalone-v1.\n",
    });
    expect(codes(snapshot([affirmative]))).not.toContain("planning-relationship-missing");
  });

  test("requires explicit dated approval for open P0", () => {
    const missingApproval = issue({
      projectItems: [projectItem({ priority: "P0" })],
    });
    const approved = issue({
      number: 2,
      body: `${issue().body}\nP0 approval: @owner on 2026-09-03 — active release emergency.\n`,
      projectItems: [projectItem({ id: "item-2", priority: "P0" })],
    });
    const report = analyzeRoadmapGovernance(snapshot([missingApproval, approved]));
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "p0-approval-missing",
    ]);
    expect(report.deliverySequence).toEqual([]);
  });

  test("requires evidence before Ready", () => {
    const readyWithoutEvidence = issue({
      projectItems: [projectItem({ readiness: "Ready" })],
    });
    const readyWithEvidence = issue({
      number: 2,
      body: `## Outcome

Deliver bounded behavior.

## Relationship

Planning relationship: Standalone-v1.

## Ready checklist

- [x] Verify the source baseline.
`,
      projectItems: [projectItem({ id: "item-2", readiness: "Ready" })],
    });
    expect(codes(snapshot([readyWithoutEvidence, readyWithEvidence]))).toEqual([
      "readiness-evidence-mismatch",
    ]);
  });

  test("rejects an open issue assigned to a closed milestone", () => {
    const input = issue({ milestoneState: "CLOSED" });
    const report = analyzeRoadmapGovernance(snapshot([input]));
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["milestone-closed"]);
    expect(report.deliverySequence).toEqual([]);
  });

  test("reconciles relationship state and reciprocal hierarchy", () => {
    const mismatchedChild = issue({
      number: 2,
      parent: { repository: REPOSITORY, number: 1, state: "CLOSED" },
      projectItems: [projectItem({ id: "item-2" })],
    });
    const parent = issue({
      body: "## Outcome\n\nDeliver an integrated outcome.\n",
      subIssues: [{ repository: REPOSITORY, number: 2, state: "OPEN" }],
      projectItems: [projectItem({ readiness: "Parent" })],
    });
    const mismatchReport = analyzeRoadmapGovernance(snapshot([parent, mismatchedChild]));
    expect(mismatchReport.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "relationship-state-mismatch",
    ]);
    expect(mismatchReport.deliverySequence).toEqual([]);

    const unlinkedChild = issue({
      number: 2,
      parent: null,
      projectItems: [projectItem({ id: "item-2" })],
    });
    const reciprocityReport = analyzeRoadmapGovernance(snapshot([parent, unlinkedChild]));
    expect(reciprocityReport.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "hierarchy-not-reciprocal",
    ]);
    expect(reciprocityReport.deliverySequence).toEqual([]);
  });

  test("requires native children to preserve the parent milestone", () => {
    const parent = issue({
      body: "## Outcome\n\nDeliver the parent.\n",
      milestone: "v0.9 Hardening and Distribution",
      subIssues: [{ repository: REPOSITORY, number: 2, state: "OPEN" }],
      projectItems: [projectItem({ readiness: "Parent" })],
    });
    const child = issue({
      number: 2,
      milestone: "v0.5 Web and Computer Use",
      parent: { repository: REPOSITORY, number: 1, state: "OPEN" },
      projectItems: [projectItem({ id: "item-2" })],
    });
    expect(codes(snapshot([parent, child]))).toEqual(["hierarchy-milestone-mismatch"]);
    const declared = issue({
      ...child,
      body: [
        child.body,
        "Milestone exception: early-prerequisite-v1; parent tyldra-org/falryn#1; child v0.5 Web and Computer Use; parent v0.9 Hardening and Distribution.",
      ].join("\n"),
    });
    expect(codes(snapshot([parent, declared]))).toEqual([]);

    const closedChild = issue({
      ...child,
      state: "CLOSED",
      closedAt: "2026-09-01T12:00:00.000Z",
      updatedAt: "2026-09-01T12:00:00.000Z",
      parent: null,
      projectItems: [
        projectItem({
          id: "item-2",
          status: "Done",
          statusUpdatedAt: "2026-09-01T13:00:00.000Z",
          readiness: "Historical",
        }),
      ],
    });
    const parentWithClosedChild = issue({
      ...parent,
      subIssues: [{ repository: REPOSITORY, number: 2, state: "CLOSED" }],
      projectItems: [projectItem({ status: "In Progress", readiness: "Parent" })],
    });
    expect(codes(snapshot([parentWithClosedChild, closedChild]))).toEqual([
      "hierarchy-milestone-mismatch",
    ]);
    const missingMilestone = issue({ ...closedChild, milestone: null });
    expect(codes(snapshot([parentWithClosedChild, missingMilestone]))).toEqual([
      "hierarchy-milestone-missing",
    ]);

    const unknownClosedParent = issue({
      ...parent,
      state: "CLOSED",
      milestone: "Unordered historical milestone",
      updatedAt: "2026-09-01T12:00:00.000Z",
      closedAt: "2026-09-01T12:00:00.000Z",
      projectItems: [
        projectItem({
          status: "Done",
          statusUpdatedAt: "2026-09-01T13:00:00.000Z",
          priority: "Historical",
          readiness: "Historical",
        }),
      ],
    });
    const childOfUnknownParent = issue({
      ...child,
      parent: { repository: REPOSITORY, number: 1, state: "CLOSED" },
      body: [
        child.body,
        "Milestone exception: early-prerequisite-v1; parent tyldra-org/falryn#1; child v0.5 Web and Computer Use; parent Unordered historical milestone.",
      ].join("\n"),
    });
    expect(codes(snapshot([unknownClosedParent, childOfUnknownParent]))).toEqual([
      "hierarchy-milestone-mismatch",
    ]);
  });

  test("rejects hierarchy deeper than one native level", () => {
    const grandparent = issue({
      body: "## Outcome\n\nDeliver the grandparent.\n",
      subIssues: [{ repository: REPOSITORY, number: 2, state: "OPEN" }],
      projectItems: [projectItem({ readiness: "Parent" })],
    });
    const middle = issue({
      number: 2,
      body: "## Outcome\n\nDeliver the middle outcome.\n",
      parent: { repository: REPOSITORY, number: 1, state: "OPEN" },
      subIssues: [{ repository: REPOSITORY, number: 3, state: "OPEN" }],
      projectItems: [projectItem({ id: "item-2", readiness: "Parent" })],
    });
    const child = issue({
      number: 3,
      parent: { repository: REPOSITORY, number: 2, state: "OPEN" },
      projectItems: [projectItem({ id: "item-3" })],
    });
    expect(codes(snapshot([grandparent, middle, child]))).toEqual(["hierarchy-depth-invalid"]);
  });

  test("classifies open parents separately from implementation leaves", () => {
    const child = issue({
      number: 2,
      parent: { repository: REPOSITORY, number: 1, state: "OPEN" },
      projectItems: [projectItem({ id: "item-2" })],
    });
    const parent = issue({
      body: "## Outcome\n\nDeliver an integrated outcome.\n",
      subIssues: [{ repository: REPOSITORY, number: 2, state: "OPEN" }],
      projectItems: [projectItem({ readiness: "Parent" })],
    });
    const report = analyzeRoadmapGovernance(snapshot([parent, child]));
    expect(report.diagnostics).toEqual([]);
    expect(report.deliverySequence.map((entry) => entry.issueNumber)).toEqual([2]);
  });

  test("orders prerequisites before higher-priority dependents", () => {
    const prerequisite = issue({
      number: 10,
      title: "Build prerequisite",
      createdAt: "2026-09-02T00:00:00.000Z",
      milestone: "v0.5 Web and Computer Use",
      projectItems: [projectItem({ id: "item-10", priority: "P3" })],
    });
    const dependent = issue({
      number: 20,
      title: "Deliver earlier-milestone outcome",
      createdAt: "2026-09-01T00:00:00.000Z",
      blockedBy: [{ repository: REPOSITORY, number: 10, state: "OPEN" }],
      projectItems: [projectItem({ id: "item-20", priority: "P1" })],
    });
    const report = analyzeRoadmapGovernance(snapshot([dependent, prerequisite]));
    expect(report.deliverySequence.map((entry) => entry.issueNumber)).toEqual([10, 20]);
    expect(report.deliverySequence[0]?.crossMilestonePrerequisite).toBe(true);
  });

  test("orders offset timestamps by absolute creation time", () => {
    const earlier = issue({
      number: 2,
      createdAt: "2026-09-01T01:00:00+02:00",
      updatedAt: "2026-09-01T02:00:00+02:00",
    });
    const later = issue({
      number: 1,
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-01T00:30:00Z",
      projectItems: [projectItem({ id: "item-1" })],
    });
    const report = analyzeRoadmapGovernance(snapshot([later, earlier]));
    expect(report.diagnostics).toEqual([]);
    expect(report.deliverySequence.map((entry) => entry.issueNumber)).toEqual([2, 1]);
  });

  test("uses milestone, priority, unlock count, and creation as stable frontier ties", () => {
    const earlyP2 = issue({
      number: 2,
      createdAt: "2026-08-01T00:00:00.000Z",
      projectItems: [projectItem({ id: "item-2", priority: "P2" })],
    });
    const p1Unlocker = issue({
      number: 3,
      createdAt: "2026-08-02T00:00:00.000Z",
      projectItems: [projectItem({ id: "item-3", priority: "P1" })],
    });
    const blocked = issue({
      number: 4,
      blockedBy: [{ repository: REPOSITORY, number: 3, state: "OPEN" }],
      projectItems: [projectItem({ id: "item-4", priority: "P1" })],
    });
    const laterMilestone = issue({
      number: 5,
      body: `${issue().body}\nP0 approval: @owner on 2026-09-03 — active release emergency.\n`,
      milestone: "v0.9 Hardening and Distribution",
      projectItems: [projectItem({ id: "item-5", priority: "P0" })],
    });
    const report = analyzeRoadmapGovernance(
      snapshot([earlyP2, p1Unlocker, blocked, laterMilestone]),
    );
    expect(report.deliverySequence.map((entry) => entry.issueNumber)).toEqual([5, 3, 4, 2]);
  });

  test("accepts parent continuity and detects stale leaf activity", () => {
    const startedChild = issue({
      number: 2,
      state: "CLOSED",
      closedAt: "2026-09-01T00:00:00.000Z",
      parent: { repository: REPOSITORY, number: 1, state: "OPEN" },
      projectItems: [
        projectItem({ id: "item-2", status: "Done", priority: "P2", readiness: "Historical" }),
      ],
    });
    const remainingChild = issue({
      number: 3,
      parent: { repository: REPOSITORY, number: 1, state: "OPEN" },
      projectItems: [projectItem({ id: "item-3" })],
    });
    const parent = issue({
      body: "## Outcome\n\nDeliver an integrated outcome.\n",
      subIssues: [
        { repository: REPOSITORY, number: 2, state: "CLOSED" },
        { repository: REPOSITORY, number: 3, state: "OPEN" },
      ],
      projectItems: [projectItem({ status: "In Progress", readiness: "Parent" })],
    });
    const stale = issue({
      number: 4,
      projectItems: [
        projectItem({
          id: "item-4",
          status: "In Progress",
          statusUpdatedAt: "2026-08-01T00:00:00.000Z",
        }),
      ],
    });
    const report = analyzeRoadmapGovernance(
      snapshot([parent, startedChild, remainingChild, stale]),
    );
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["stale-in-progress"]);
    expect(report.liveness).toEqual([
      {
        repository: REPOSITORY,
        issueNumber: 1,
        kind: "parent-continuation",
        detail: "open parent has started and remaining children",
      },
      {
        repository: REPOSITORY,
        issueNumber: 4,
        kind: "stale",
        detail: "792.0 hours without an open closing pull request",
      },
    ]);
  });

  test("accepts parent verification after its final child closes", () => {
    const closedChild = issue({
      number: 2,
      state: "CLOSED",
      closedAt: "2026-09-02T00:00:00.000Z",
      parent: { repository: REPOSITORY, number: 1, state: "OPEN" },
      projectItems: [
        projectItem({
          id: "item-2",
          status: "Done",
          priority: "P2",
          readiness: "Historical",
        }),
      ],
    });
    const parent = issue({
      body: "## Outcome\n\nDeliver the integrated parent.\n",
      subIssues: [{ repository: REPOSITORY, number: 2, state: "CLOSED" }],
      projectItems: [projectItem({ status: "In Progress", readiness: "Parent" })],
    });
    const report = analyzeRoadmapGovernance(snapshot([parent, closedChild]));
    expect(report.diagnostics).toEqual([]);
    expect(report.liveness[0]?.detail).toBe(
      "all native children are closed; integrated verification remains",
    );
  });

  test("reconciles active child, parent, and closing-pull-request status", () => {
    const child = issue({
      number: 2,
      parent: { repository: REPOSITORY, number: 1, state: "OPEN" },
      projectItems: [projectItem({ id: "item-2", status: "In Progress" })],
    });
    const parent = issue({
      body: "## Outcome\n\nDeliver the integrated parent.\n",
      subIssues: [{ repository: REPOSITORY, number: 2, state: "OPEN" }],
      closingPullRequests: [
        {
          repository: REPOSITORY,
          number: 11,
          state: "OPEN",
          isDraft: true,
          updatedAt: "2026-09-02T00:00:00.000Z",
        },
      ],
      projectItems: [projectItem({ readiness: "Parent" })],
    });
    const todoLeafWithPullRequest = issue({
      number: 3,
      closingPullRequests: [
        {
          repository: REPOSITORY,
          number: 12,
          state: "OPEN",
          isDraft: true,
          updatedAt: "2026-09-02T00:00:00.000Z",
        },
        {
          repository: REPOSITORY,
          number: 13,
          state: "OPEN",
          isDraft: true,
          updatedAt: "2026-09-02T00:00:00.000Z",
        },
      ],
      projectItems: [projectItem({ id: "item-3" })],
    });
    expect(codes(snapshot([parent, child, todoLeafWithPullRequest]))).toEqual([
      "parent-closing-pr-forbidden",
      "parent-status-mismatch",
      "active-closing-pr-status-mismatch",
      "multiple-active-closing-prs",
    ]);
  });

  test("rejects In Progress work with an internal open blocker", () => {
    const blocker = issue();
    const blocked = issue({
      number: 2,
      blockedBy: [{ repository: REPOSITORY, number: 1, state: "OPEN" }],
      projectItems: [projectItem({ id: "item-2", status: "In Progress" })],
      closingPullRequests: [
        {
          repository: REPOSITORY,
          number: 100,
          state: "OPEN",
          isDraft: true,
          updatedAt: "2026-09-02T00:00:00.000Z",
        },
      ],
    });
    const report = analyzeRoadmapGovernance(snapshot([blocker, blocked]));
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "in-progress-blocked",
    ]);
    expect(report.liveness[0]?.kind).toBe("stale");
    expect(report.deliverySequence).toEqual([]);
  });

  test("accepts a bounded no-PR grace period and an open closing PR", () => {
    const grace = issue({
      projectItems: [
        projectItem({ status: "In Progress", statusUpdatedAt: "2026-09-02T00:00:00.000Z" }),
      ],
    });
    const withPullRequest = issue({
      number: 2,
      projectItems: [projectItem({ id: "item-2", status: "In Progress" })],
      closingPullRequests: [
        {
          repository: REPOSITORY,
          number: 100,
          state: "OPEN",
          isDraft: true,
          updatedAt: "2026-09-02T00:00:00.000Z",
        },
      ],
    });
    const report = analyzeRoadmapGovernance(snapshot([grace, withPullRequest]));
    expect(report.diagnostics).toEqual([]);
    expect(report.liveness.map((entry) => entry.kind)).toEqual([
      "grace-period",
      "open-pull-request",
    ]);
  });

  test("rejects Todo work with an abandoned closing pull request", () => {
    const abandoned = issue({
      closingPullRequests: [
        {
          repository: REPOSITORY,
          number: 10,
          state: "CLOSED",
          isDraft: false,
          updatedAt: "2026-09-02T00:00:00.000Z",
        },
      ],
    });
    const report = analyzeRoadmapGovernance(snapshot([abandoned]));
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "abandoned-closing-pr",
    ]);
    expect(report.deliverySequence).toEqual([]);
  });

  test("rejects In Progress after its closing pull request closes unmerged", () => {
    const stale = issue({
      projectItems: [projectItem({ status: "In Progress" })],
      closingPullRequests: [
        {
          repository: "tyldra-org/falryn",
          number: 10,
          state: "CLOSED",
          isDraft: false,
          updatedAt: "2026-09-02T00:00:00.000Z",
        },
      ],
    });
    expect(codes(snapshot([stale]))).toEqual(["in-progress-closing-pr-closed"]);
  });

  test("detects a dependency and hierarchy cycle", () => {
    const first = issue({
      blockedBy: [{ repository: REPOSITORY, number: 2, state: "OPEN" }],
    });
    const second = issue({
      number: 2,
      blockedBy: [{ repository: REPOSITORY, number: 1, state: "OPEN" }],
      projectItems: [projectItem({ id: "item-2" })],
    });
    expect(codes(snapshot([first, second]))).toContain("dependency-cycle");
  });

  test("reports open blockers outside the audited repository set", () => {
    const blocked = issue({
      blockedBy: [{ repository: "external/example", number: 9, state: "OPEN" }],
    });
    const report = analyzeRoadmapGovernance(snapshot([blocked]));
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "external-open-blocker",
    );
    expect(report.deliverySequence).toEqual([]);
  });
});
