import { describe, expect, test } from "bun:test";
import {
  analyzeRoadmapGovernance,
  parseRoadmapGovernanceSnapshot,
  ROADMAP_PLANNING_FIELDS,
  ROADMAP_PRIORITY_OPTIONS,
  ROADMAP_READINESS_OPTIONS,
  type RoadmapGovernanceIssue,
  type RoadmapGovernanceSnapshot,
  type RoadmapPlanning,
  releaseOrderKey,
  roadmapStatus,
} from "./roadmap-governance";
import { loadOpenIssueRelations, parseCli, planningFromRest } from "./roadmap-governance-cli";

const REPOSITORY = "tyldra-org/falryn";

const RELEASES = ["v0.1 Release A", "v0.2 Release B", "v0.3 Release C"] as const;

function planned(overrides: Partial<RoadmapPlanning> = {}): RoadmapPlanning {
  return {
    priority: "P2",
    readiness: "Needs Planning",
    release: "v0.1 Release A",
    releaseException: null,
    ...overrides,
  };
}

function issue(
  overrides: Partial<RoadmapGovernanceIssue> & {
    targetRelease?: string | null;
    releaseException?: string | null;
  } = {},
): RoadmapGovernanceIssue {
  const { targetRelease, releaseException, ...rest } = overrides;
  const planning = rest.planning === undefined ? planned() : rest.planning;
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
    parent: null,
    subIssues: [],
    blockedBy: [],
    closingPullRequests: [],
    ...rest,
    planning:
      planning === null
        ? null
        : {
            ...planning,
            ...(targetRelease === undefined ? {} : { release: targetRelease }),
            ...(releaseException === undefined ? {} : { releaseException }),
          },
  };
}

function readyBody(): string {
  return issue().body.replace(
    "- [ ] Verify the source baseline.",
    "- [x] Verify the source baseline.",
  );
}

function openPullRequest(number = 10) {
  return {
    repository: REPOSITORY,
    number,
    state: "OPEN" as const,
    isDraft: false,
    updatedAt: "2026-09-02T00:00:00.000Z",
  };
}

const MILESTONES = [
  { title: "v0.0 Retired release", state: "CLOSED" as const },
  ...RELEASES.map((title) => ({ title, state: "OPEN" as const })),
];

function snapshot(issues: readonly RoadmapGovernanceIssue[]): RoadmapGovernanceSnapshot {
  return {
    schemaVersion: 4,
    generatedAt: "2026-09-03T00:00:00.000Z",
    owner: "tyldra-org",
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
    planningFields: [
      {
        name: ROADMAP_PLANNING_FIELDS.priority,
        dataType: "SINGLE_SELECT",
        visibility: "ORG_ONLY",
        options: ROADMAP_PRIORITY_OPTIONS,
      },
      {
        name: ROADMAP_PLANNING_FIELDS.readiness,
        dataType: "SINGLE_SELECT",
        visibility: "ORG_ONLY",
        options: ROADMAP_READINESS_OPTIONS,
      },
      {
        name: ROADMAP_PLANNING_FIELDS.releaseException,
        dataType: "TEXT",
        visibility: "ORG_ONLY",
        options: [],
      },
    ],
    milestones: [
      { repository: REPOSITORY, milestones: MILESTONES },
      { repository: "tyldra-org/falryn-docs", milestones: MILESTONES },
    ],
    issues,
  };
}

function codes(input: RoadmapGovernanceSnapshot): readonly string[] {
  return analyzeRoadmapGovernance(input).diagnostics.map((diagnostic) => diagnostic.code);
}

describe("roadmap governance CLI validation", () => {
  test("rejects partial live repository selection", () => {
    expect(() => parseCli(["--live", REPOSITORY])).toThrow("live audit requires exactly");
    expect(() => parseCli(["--live", REPOSITORY, "--project-number", "1"])).toThrow(
      "unknown argument: --project-number",
    );
  });

  test("orders releases by the version in the milestone title", () => {
    expect(releaseOrderKey("v0.35 Live Product Coding Agent")).toBe(0.35);
    expect(releaseOrderKey("v0.3 Intelligence")).toBeLessThan(releaseOrderKey("v0.35 Live") ?? 0);
    expect(releaseOrderKey("v0.35 Live")).toBeLessThan(releaseOrderKey("v0.4 Extensions") ?? 0);
    expect(releaseOrderKey("Community")).toBeNull();
  });

  test("reads planning facts from the REST issue record", () => {
    const record = {
      milestone: { title: "v0.4 Extensions and Collaboration" },
      issue_field_values: [
        { issue_field_name: "Roadmap priority", single_select_option: { name: "P2" } },
        { issue_field_name: "Readiness", single_select_option: { name: "Ready" } },
        { issue_field_name: "Release exception", value: "early-prerequisite-v1; …" },
        { issue_field_name: "Priority", single_select_option: { name: "High" } },
      ],
    };
    expect(planningFromRest(record, "issue")).toEqual({
      priority: "P2",
      readiness: "Ready",
      release: "v0.4 Extensions and Collaboration",
      releaseException: "early-prerequisite-v1; …",
    });
    expect(
      planningFromRest(
        {
          milestone: { title: "v0.4 Extensions and Collaboration" },
          issue_field_values: [
            { issue_field_name: "Priority", single_select_option: { name: "High" } },
          ],
        },
        "issue",
      ),
    ).toBeNull();
    expect(planningFromRest({ milestone: null }, "issue")).toBeNull();
  });
});

describe("live closing-pull-request collection", () => {
  test.each(["closed", "replacement", "merged"] as const)(
    "preserves %s delivery evidence through collection and analysis",
    async (scenario) => {
      const closed = {
        repository: { nameWithOwner: REPOSITORY },
        number: 10,
        state: "CLOSED" as const,
        isDraft: false,
        updatedAt: "2026-09-02T00:00:00.000Z",
      };
      const expected =
        scenario === "replacement"
          ? [closed, { ...closed, number: 11, state: "OPEN" as const, isDraft: true }]
          : [
              {
                ...closed,
                state: scenario === "merged" ? ("MERGED" as const) : ("CLOSED" as const),
              },
            ];
      const queries: string[][] = [];
      const collected = await loadOpenIssueRelations(REPOSITORY, async (args) => {
        queries.push([...args]);
        const query = args.find((arg) => arg.startsWith("query=")) ?? "";
        // GitHub omits CLOSED relationships unless the caller opts in.
        const native = expected.filter(
          (pr) => pr.state !== "CLOSED" || /includeClosedPrs\s*:\s*true/.test(query),
        );
        const secondPage = args.includes("after=next-issue");
        return {
          data: {
            repository: {
              allIssues: { totalCount: 2 },
              issues: {
                totalCount: 2,
                pageInfo: { hasNextPage: !secondPage, endCursor: secondPage ? null : "next-issue" },
                nodes: [
                  {
                    number: secondPage ? 2 : 1,
                    parent: null,
                    subIssues: { totalCount: 0, nodes: [] },
                    blockedBy: { totalCount: 0, nodes: [] },
                    closedByPullRequestsReferences: {
                      totalCount: secondPage ? native.length : 0,
                      nodes: secondPage ? native : [],
                    },
                    projectItems: { totalCount: 0, nodes: [] },
                  },
                ],
              },
            },
          },
        };
      });
      expect(queries).toHaveLength(2);
      expect(queries[1]).toContain("after=next-issue");
      expect(collected.totalIssueCount).toBe(2);
      const relations = collected.relations.get(2);
      expect(relations?.closingPullRequests.map((pr) => pr.state)).toEqual(
        expected.map((pr) => pr.state),
      );
      const subject = issue({
        number: 2,
        body: readyBody(),
        ...relations,
        planning: planned({ readiness: "Ready" }),
      });
      const report = analyzeRoadmapGovernance(snapshot([subject]));
      if (scenario === "closed") {
        expect(report.diagnostics.map((entry) => entry.code)).toEqual(["abandoned-closing-pr"]);
        expect(report.deliverySequence).toEqual([]);
      } else if (scenario === "replacement") {
        expect(report.diagnostics).toEqual([]);
        expect(report.liveness[0]?.kind).toBe("open-pull-request");
      } else {
        expect(report.diagnostics.map((entry) => entry.code)).toEqual([
          "open-issue-merged-closing-pr",
        ]);
      }
    },
  );

  test("refuses truncated native closing relationships", async () => {
    await expect(
      loadOpenIssueRelations(REPOSITORY, async () => ({
        data: {
          repository: {
            allIssues: { totalCount: 1 },
            issues: {
              totalCount: 1,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  number: 1,
                  parent: null,
                  subIssues: { totalCount: 0, nodes: [] },
                  blockedBy: { totalCount: 0, nodes: [] },
                  closedByPullRequestsReferences: { totalCount: 101, nodes: [] },
                  projectItems: { totalCount: 0, nodes: [] },
                },
              ],
            },
          },
        },
      })),
    ).rejects.toThrow("closedByPullRequestsReferences");
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
      planning: planned({
        priority: "Historical",
        readiness: "Historical",
      }),
    });
    expect(analyzeRoadmapGovernance(snapshot([issue(), closed])).diagnostics).toEqual([]);
  });

  test("requires the organization-only planning fields exactly", () => {
    const value = snapshot([issue()]);
    const [priority, readiness, exception] = value.planningFields;
    if (priority === undefined || readiness === undefined || exception === undefined) {
      throw new Error("fixture planning fields are missing");
    }
    expect(codes({ ...value, planningFields: [readiness, exception] })).toEqual([
      "planning-field-invalid",
    ]);
    expect(
      codes({
        ...value,
        planningFields: [{ ...priority, visibility: "ALL" }, readiness, exception],
      }),
    ).toEqual(["planning-field-invalid"]);
    expect(
      codes({
        ...value,
        planningFields: [
          {
            ...priority,
            options: priority.options.map((option) =>
              option.name === "P2" ? { ...option, description: "Normal work" } : option,
            ),
          },
          readiness,
          exception,
        ],
      }),
    ).toEqual(["planning-field-invalid"]);
    expect(
      codes({
        ...value,
        planningFields: [priority, readiness, { ...exception, dataType: "SINGLE_SELECT" }],
      }),
    ).toEqual(["planning-field-invalid"]);
  });

  test("requires one release catalog shared by both repositories", () => {
    const value = snapshot([issue()]);
    const [falryn, docs] = value.milestones;
    if (falryn === undefined || docs === undefined) {
      throw new Error("fixture milestones are missing");
    }
    const withDocs = (milestones: typeof docs.milestones) => ({
      ...value,
      milestones: [falryn, { ...docs, milestones }],
    });
    expect(codes(withDocs(docs.milestones.slice(1)))).toEqual(["release-catalog-invalid"]);
    expect(
      codes(
        withDocs(
          docs.milestones.map((milestone) =>
            milestone.title === "v0.1 Release A" ? { ...milestone, state: "CLOSED" } : milestone,
          ),
        ),
      ),
    ).toEqual(["release-catalog-invalid", "target-release-order-unknown"]);
    expect(
      codes({
        ...value,
        milestones: value.milestones.map((entry) => ({
          ...entry,
          milestones: [...entry.milestones, { title: "Community", state: "OPEN" as const }],
        })),
      }),
    ).toEqual(["release-catalog-invalid"]);
    expect(
      codes({
        ...value,
        milestones: value.milestones.map((entry) => ({
          ...entry,
          milestones: [
            ...entry.milestones,
            { title: "v0.10 Duplicate order", state: "OPEN" as const },
          ],
        })),
      }),
    ).toEqual(["release-catalog-invalid"]);
  });

  test("ignores contribution issues without Roadmap fields", () => {
    const contribution = issue({ planning: null });
    expect(codes(snapshot([contribution]))).toEqual([]);
    expect(analyzeRoadmapGovernance(snapshot([contribution])).deliverySequence).toEqual([]);
  });

  test("requires valid classifications for Roadmap-owned issues", () => {
    const invalid = issue({
      planning: planned({
        priority: "Historical",
        readiness: "Historical",
      }),
    });
    expect(codes(snapshot([invalid]))).toEqual(["open-historical-priority", "readiness-invalid"]);
  });

  test("requires open Roadmap dependencies to be adopted into the Project", () => {
    const planned = issue({
      blockedBy: [{ repository: REPOSITORY, number: 2, state: "OPEN" }],
    });
    const contribution = issue({ number: 2, planning: null });

    expect(codes(snapshot([planned, contribution]))).toEqual(["relationship-target-missing"]);
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
      planning: planned({ priority: "P0" }),
    });
    const approved = issue({
      number: 2,
      body: `${issue().body}\nP0 approval: @owner on 2026-09-03 — active release emergency.\n`,
      planning: planned({ priority: "P0" }),
    });
    const report = analyzeRoadmapGovernance(snapshot([missingApproval, approved]));
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "p0-approval-missing",
    ]);
    expect(report.deliverySequence).toEqual([]);
  });

  test("requires evidence before Ready", () => {
    const readyWithoutEvidence = issue({
      planning: planned({ readiness: "Ready" }),
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
      planning: planned({ readiness: "Ready" }),
    });
    expect(codes(snapshot([readyWithoutEvidence, readyWithEvidence]))).toEqual([
      "readiness-evidence-mismatch",
    ]);
  });

  test("requires a named decision owner for Needs Decision", () => {
    const missingDecision = issue({
      planning: planned({ readiness: "Needs Decision" }),
    });
    const namedDecision = issue({
      number: 2,
      body: `${issue().body}\nDecision required: @maintainer — choose the public fallback behavior.\n`,
      planning: planned({ readiness: "Needs Decision" }),
    });
    const report = analyzeRoadmapGovernance(snapshot([missingDecision, namedDecision]));
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "decision-evidence-missing",
    ]);
    expect(report.deliverySequence).toEqual([]);
    expect(analyzeRoadmapGovernance(snapshot([namedDecision])).deliverySequence[0]?.readiness).toBe(
      "Needs Decision",
    );
  });

  test("requires active implementation leaves to remain Ready", () => {
    const input = issue({
      planning: planned({ readiness: "Needs Planning" }),
      closingPullRequests: [
        {
          repository: REPOSITORY,
          number: 10,
          state: "OPEN",
          isDraft: true,
          updatedAt: "2026-09-02T00:00:00.000Z",
        },
      ],
    });
    expect(codes(snapshot([input]))).toEqual(["in-progress-readiness-invalid"]);
  });

  test("rejects an open issue assigned to a closed release", () => {
    const input = issue({ targetRelease: "v0.0 Retired release" });
    const report = analyzeRoadmapGovernance(snapshot([input]));
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "target-release-closed",
    ]);
    expect(report.deliverySequence).toEqual([]);
  });

  test("reconciles relationship state and reciprocal hierarchy", () => {
    const mismatchedChild = issue({
      number: 2,
      parent: { repository: REPOSITORY, number: 1, state: "CLOSED" },
      planning: planned(),
    });
    const parent = issue({
      body: "## Outcome\n\nDeliver an integrated outcome.\n",
      subIssues: [{ repository: REPOSITORY, number: 2, state: "OPEN" }],
      planning: planned({ readiness: "Parent" }),
    });
    const mismatchReport = analyzeRoadmapGovernance(snapshot([parent, mismatchedChild]));
    expect(mismatchReport.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "relationship-state-mismatch",
    ]);
    expect(mismatchReport.deliverySequence).toEqual([]);

    const unlinkedChild = issue({
      number: 2,
      parent: null,
      planning: planned(),
    });
    const reciprocityReport = analyzeRoadmapGovernance(snapshot([parent, unlinkedChild]));
    expect(reciprocityReport.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "hierarchy-not-reciprocal",
    ]);
    expect(reciprocityReport.deliverySequence).toEqual([]);
  });

  test("requires native children to preserve the parent release", () => {
    const parent = issue({
      body: "## Outcome\n\nDeliver the parent.\n",
      targetRelease: "v0.3 Release C",
      subIssues: [{ repository: REPOSITORY, number: 2, state: "OPEN" }],
      planning: planned({ readiness: "Parent" }),
    });
    const child = issue({
      number: 2,
      targetRelease: "v0.2 Release B",
      parent: { repository: REPOSITORY, number: 1, state: "OPEN" },
      planning: planned(),
    });
    expect(codes(snapshot([parent, child]))).toEqual(["hierarchy-target-release-mismatch"]);
    const declared = issue({
      ...child,
      releaseException:
        "early-prerequisite-v1; parent tyldra-org/falryn#1; child v0.2 Release B; parent v0.3 Release C.",
    });
    expect(codes(snapshot([parent, declared]))).toEqual([]);

    const closedChild = issue({
      ...child,
      state: "CLOSED",
      closedAt: "2026-09-01T12:00:00.000Z",
      updatedAt: "2026-09-01T12:00:00.000Z",
      parent: null,
      planning: planned({
        readiness: "Historical",
      }),
    });
    const parentWithClosedChild = issue({
      ...parent,
      targetRelease: "v0.3 Release C",
      subIssues: [{ repository: REPOSITORY, number: 2, state: "CLOSED" }],
      planning: planned({ readiness: "Parent" }),
    });
    expect(codes(snapshot([parentWithClosedChild, closedChild]))).toEqual([
      "hierarchy-target-release-mismatch",
    ]);
    const missingRelease = issue({ ...closedChild, targetRelease: null });
    expect(codes(snapshot([parentWithClosedChild, missingRelease]))).toEqual([
      "hierarchy-target-release-missing",
    ]);

    const unknownClosedParent = issue({
      ...parent,
      state: "CLOSED",
      targetRelease: "Unordered historical release",
      updatedAt: "2026-09-01T12:00:00.000Z",
      closedAt: "2026-09-01T12:00:00.000Z",
      planning: planned({
        priority: "Historical",
        readiness: "Historical",
      }),
    });
    const childOfUnknownParent = issue({
      ...child,
      parent: { repository: REPOSITORY, number: 1, state: "CLOSED" },
      releaseException:
        "early-prerequisite-v1; parent tyldra-org/falryn#1; child v0.2 Release B; parent Unordered historical release.",
    });
    expect(codes(snapshot([unknownClosedParent, childOfUnknownParent]))).toEqual([
      "hierarchy-target-release-mismatch",
      "release-exception-invalid",
    ]);
  });

  test("rejects hierarchy deeper than one native level", () => {
    const grandparent = issue({
      body: "## Outcome\n\nDeliver the grandparent.\n",
      subIssues: [{ repository: REPOSITORY, number: 2, state: "OPEN" }],
      planning: planned({ readiness: "Parent" }),
    });
    const middle = issue({
      number: 2,
      body: "## Outcome\n\nDeliver the middle outcome.\n",
      parent: { repository: REPOSITORY, number: 1, state: "OPEN" },
      subIssues: [{ repository: REPOSITORY, number: 3, state: "OPEN" }],
      planning: planned({ readiness: "Parent" }),
    });
    const child = issue({
      number: 3,
      parent: { repository: REPOSITORY, number: 2, state: "OPEN" },
      planning: planned(),
    });
    expect(codes(snapshot([grandparent, middle, child]))).toEqual(["hierarchy-depth-invalid"]);
  });

  test("classifies open parents separately from implementation leaves", () => {
    const child = issue({
      number: 2,
      parent: { repository: REPOSITORY, number: 1, state: "OPEN" },
      planning: planned(),
    });
    const parent = issue({
      body: "## Outcome\n\nDeliver an integrated outcome.\n",
      subIssues: [{ repository: REPOSITORY, number: 2, state: "OPEN" }],
      planning: planned({ readiness: "Parent" }),
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
      targetRelease: "v0.2 Release B",
      planning: planned({ priority: "P3" }),
    });
    const dependent = issue({
      number: 20,
      title: "Deliver earlier-release outcome",
      createdAt: "2026-09-01T00:00:00.000Z",
      blockedBy: [{ repository: REPOSITORY, number: 10, state: "OPEN" }],
      planning: planned({ priority: "P1" }),
    });
    const report = analyzeRoadmapGovernance(snapshot([dependent, prerequisite]));
    expect(report.deliverySequence.map((entry) => entry.issueNumber)).toEqual([10, 20]);
    expect(report.deliverySequence[0]?.crossReleasePrerequisite).toBe(true);
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
      planning: planned(),
    });
    const report = analyzeRoadmapGovernance(snapshot([later, earlier]));
    expect(report.diagnostics).toEqual([]);
    expect(report.deliverySequence.map((entry) => entry.issueNumber)).toEqual([2, 1]);
  });

  test("uses release, priority, unlock count, and creation as stable frontier ties", () => {
    const earlyP2 = issue({
      number: 2,
      createdAt: "2026-08-01T00:00:00.000Z",
      planning: planned({ priority: "P2" }),
    });
    const p1Unlocker = issue({
      number: 3,
      createdAt: "2026-08-02T00:00:00.000Z",
      planning: planned({ priority: "P1" }),
    });
    const blocked = issue({
      number: 4,
      blockedBy: [{ repository: REPOSITORY, number: 3, state: "OPEN" }],
      planning: planned({ priority: "P1" }),
    });
    const laterRelease = issue({
      number: 5,
      body: `${issue().body}\nP0 approval: @owner on 2026-09-03 — active release emergency.\n`,
      targetRelease: "v0.3 Release C",
      planning: planned({ priority: "P0" }),
    });
    const report = analyzeRoadmapGovernance(snapshot([earlyP2, p1Unlocker, blocked, laterRelease]));
    expect(report.deliverySequence.map((entry) => entry.issueNumber)).toEqual([5, 3, 4, 2]);
  });

  test("derives Status from issue state, closing pull requests and children", () => {
    const startedChild = issue({
      number: 2,
      state: "CLOSED",
      closedAt: "2026-09-01T00:00:00.000Z",
      parent: { repository: REPOSITORY, number: 1, state: "OPEN" },
      planning: planned({ priority: "P2", readiness: "Historical" }),
    });
    const remainingChild = issue({
      number: 3,
      parent: { repository: REPOSITORY, number: 1, state: "OPEN" },
      planning: planned(),
    });
    const parent = issue({
      body: "## Outcome\n\nDeliver an integrated outcome.\n",
      subIssues: [
        { repository: REPOSITORY, number: 2, state: "CLOSED" },
        { repository: REPOSITORY, number: 3, state: "OPEN" },
      ],
      planning: planned({ readiness: "Parent" }),
    });
    const unstartedLeaf = issue({
      number: 4,
      body: readyBody(),
      planning: planned({ readiness: "Ready" }),
    });
    const activeLeaf = issue({
      number: 5,
      body: readyBody(),
      planning: planned({ readiness: "Ready" }),
      closingPullRequests: [openPullRequest()],
    });
    const all = [parent, startedChild, remainingChild, unstartedLeaf, activeLeaf];
    const byKey = new Map(
      all.map((entry) => [`${entry.repository}#${entry.number}` as const, entry]),
    );
    expect(all.map((entry) => roadmapStatus(entry, byKey))).toEqual([
      "In Progress",
      "Done",
      "Todo",
      "Todo",
      "In Progress",
    ]);
    const report = analyzeRoadmapGovernance(snapshot(all));
    expect(report.diagnostics).toEqual([]);
    expect(report.liveness).toEqual([
      {
        repository: REPOSITORY,
        issueNumber: 1,
        kind: "parent-continuation",
        detail: "open parent has started and remaining children",
      },
      {
        repository: REPOSITORY,
        issueNumber: 5,
        kind: "open-pull-request",
        detail: "open closing pull request proves active delivery",
      },
    ]);
    expect(report.deliverySequence.map((row) => [row.issueNumber, row.status])).toEqual([
      [5, "In Progress"],
      [3, "Todo"],
      [4, "Todo"],
    ]);
  });

  test("accepts parent verification after its final child closes", () => {
    const closedChild = issue({
      number: 2,
      state: "CLOSED",
      closedAt: "2026-09-02T00:00:00.000Z",
      parent: { repository: REPOSITORY, number: 1, state: "OPEN" },
      planning: planned({ priority: "P2", readiness: "Historical" }),
    });
    const parent = issue({
      body: "## Outcome\n\nDeliver the integrated parent.\n",
      subIssues: [{ repository: REPOSITORY, number: 2, state: "CLOSED" }],
      planning: planned({ readiness: "Parent" }),
    });
    const report = analyzeRoadmapGovernance(snapshot([parent, closedChild]));
    expect(report.diagnostics).toEqual([]);
    expect(report.liveness[0]?.detail).toBe(
      "all native children are closed; integrated verification remains",
    );
  });

  test("rejects parent pull requests and competing leaf pull requests", () => {
    const child = issue({
      number: 2,
      body: readyBody(),
      parent: { repository: REPOSITORY, number: 1, state: "OPEN" },
      planning: planned({ readiness: "Ready" }),
    });
    const parent = issue({
      body: "## Outcome\n\nDeliver the integrated parent.\n",
      subIssues: [{ repository: REPOSITORY, number: 2, state: "OPEN" }],
      closingPullRequests: [openPullRequest(11)],
      planning: planned({ readiness: "Parent" }),
    });
    const competing = issue({
      number: 3,
      body: readyBody(),
      planning: planned({ readiness: "Ready" }),
      closingPullRequests: [openPullRequest(12), openPullRequest(13)],
    });
    expect(codes(snapshot([parent, child, competing]))).toEqual([
      "parent-closing-pr-forbidden",
      "multiple-active-closing-prs",
    ]);
  });

  test("rejects In Progress work with an internal open blocker", () => {
    const blocker = issue();
    const blocked = issue({
      number: 2,
      body: readyBody(),
      blockedBy: [{ repository: REPOSITORY, number: 1, state: "OPEN" }],
      planning: planned({ readiness: "Ready" }),
      closingPullRequests: [openPullRequest(100)],
    });
    const report = analyzeRoadmapGovernance(snapshot([blocker, blocked]));
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "in-progress-blocked",
    ]);
    expect(report.liveness[0]?.kind).toBe("stale");
    expect(report.deliverySequence).toEqual([]);
  });

  test("treats a leaf whose closing pull request closed unmerged as abandoned Todo", () => {
    const abandoned = issue({
      body: readyBody(),
      planning: planned({ readiness: "Ready" }),
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
    expect(report.liveness).toEqual([]);
    expect(report.deliverySequence).toEqual([]);
  });

  test("detects a dependency and hierarchy cycle", () => {
    const first = issue({
      blockedBy: [{ repository: REPOSITORY, number: 2, state: "OPEN" }],
    });
    const second = issue({
      number: 2,
      blockedBy: [{ repository: REPOSITORY, number: 1, state: "OPEN" }],
      planning: planned(),
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

describe("release planning", () => {
  test("orders releases by milestone title version, not milestone listing order", () => {
    const first = issue({ number: 1, targetRelease: "v0.2 Release B" });
    const second = issue({ number: 2, targetRelease: "v0.1 Release A" });
    const original = snapshot([first, second]);
    const reversed = {
      ...original,
      milestones: original.milestones.map((entry) => ({
        ...entry,
        milestones: [...entry.milestones].reverse(),
      })),
    };
    for (const value of [original, reversed]) {
      expect(
        analyzeRoadmapGovernance(value).deliverySequence.map((row) => row.issueNumber),
      ).toEqual([2, 1]);
    }
  });

  test("reports unknown and missing releases", () => {
    expect(codes(snapshot([issue({ targetRelease: "v9.9 Unknown release" })]))).toEqual([
      "target-release-order-unknown",
    ]);
    expect(codes(snapshot([issue({ targetRelease: null })]))).toEqual(["target-release-missing"]);
  });

  test("accepts a release exception only from its planning field and matching releases", () => {
    const parent = issue({
      targetRelease: "v0.3 Release C",
      subIssues: [{ repository: REPOSITORY, number: 2, state: "OPEN" }],
      planning: planned({ readiness: "Parent" }),
    });
    const declaration =
      "early-prerequisite-v1; parent tyldra-org/falryn#1; child v0.2 Release B; parent v0.3 Release C.";
    const child = issue({
      number: 2,
      targetRelease: "v0.2 Release B",
      parent: { repository: REPOSITORY, number: 1, state: "OPEN" },
      body: `Release exception: ${declaration}`,
    });
    expect(codes(snapshot([parent, child]))).toEqual(["hierarchy-target-release-mismatch"]);
    expect(codes(snapshot([parent, issue({ ...child, releaseException: declaration })]))).toEqual(
      [],
    );
    expect(codes(snapshot([issue({ releaseException: declaration })]))).toContain(
      "release-exception-invalid",
    );
  });

  test("rejects schema-3 Project snapshots", () => {
    expect(() =>
      parseRoadmapGovernanceSnapshot({ ...snapshot([issue()]), schemaVersion: 3 }),
    ).toThrow("schemaVersion must be 4");
    const { milestones: _milestones, ...missing } = snapshot([issue()]);
    expect(() => parseRoadmapGovernanceSnapshot(missing)).toThrow("snapshot.milestones");
  });
});
