import { describe, expect, test } from "bun:test";

import {
  auditIssueReadiness,
  type IssueReadinessIssue,
  type IssueReadinessSnapshot,
  parseIssueReadinessSnapshot,
} from "./issue-readiness.ts";

function issue(overrides: Partial<IssueReadinessIssue> = {}): IssueReadinessIssue {
  return {
    number: 1,
    title: "Implement the fixture",
    body: [
      "## Outcome",
      "",
      "Deliver one deterministic fixture.",
      "",
      "## Relationship",
      "",
      "Planning relationship: Standalone-v1.",
      "",
      "## Completion proof",
      "",
      "Complete when the fixture passes.",
    ].join("\n"),
    state: "OPEN",
    updatedAt: "2026-09-02T00:00:00Z",
    assignees: ["maintainer"],
    labels: ["type: chore", "area: docs"],
    milestone: "v0.4 Extensions and Collaboration",
    roadmapItemCount: 1,
    roadmapStatuses: ["Todo"],
    parent: null,
    subIssues: [],
    blockedBy: [],
    ...overrides,
  };
}

function snapshot(issues: readonly IssueReadinessIssue[]): IssueReadinessSnapshot {
  return {
    schemaVersion: 2,
    repository: "tyldra-org/falryn",
    generatedAt: "2026-09-02T00:00:00Z",
    issues,
  };
}

function codes(
  input: IssueReadinessSnapshot,
  options: Parameters<typeof auditIssueReadiness>[1] = {},
): readonly string[] {
  return auditIssueReadiness(input, options).map((diagnostic) => diagnostic.code);
}

describe("issue readiness audit", () => {
  test("accepts deterministic standalone and parent-child contracts", () => {
    const parent = issue({
      number: 1,
      title: "Parent outcome",
      body: "## Outcome\n\nDeliver the parent.\n\n## Completion proof\n\nComplete after integration.",
      subIssues: [{ number: 2, state: "OPEN" }],
    });
    const child = issue({
      number: 2,
      title: "Child slice",
      body: "## Outcome\n\n- **Parent outcome:** #1.\n- **Open blockers:** #3.\n\n## Completion proof\n\nComplete when tested.",
      parent: { number: 1, state: "OPEN" },
      blockedBy: [{ number: 3, state: "OPEN" }],
    });
    const blocker = issue({ number: 3, title: "Blocker" });
    const accepted = issue({
      number: 4,
      body: "## Outcome\n\nStandalone qualification.\n\nPlanning relationship: Standalone-v1.\n\n## Accepted terminal outcomes\n\nAccepted or rejected with evidence.",
    });

    expect(auditIssueReadiness(snapshot([blocker, child, parent, accepted]))).toEqual([]);
    expect(auditIssueReadiness(snapshot([accepted, parent, child, blocker]))).toEqual([]);
  });

  test("accepts the level-three headings emitted by GitHub issue forms", () => {
    const issueFormBody = issue({
      body: [
        "### Outcome",
        "",
        "Deliver one deterministic fixture.",
        "",
        "### Planning relationship",
        "",
        "Standalone",
        "",
        "### Completion proof",
        "",
        "Complete when the fixture passes.",
      ].join("\n"),
    });

    expect(auditIssueReadiness(snapshot([issueFormBody]))).toEqual([]);
  });

  test("does not accept noncanonical or negated Standalone text as a relationship", () => {
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
      const negated = issue({
        body: issue().body.replace("Planning relationship: Standalone-v1.", declaration),
      });
      expect(codes(snapshot([negated]))).toContain("planning-relationship-missing");
    }
  });

  test("rejects malformed or duplicate snapshot identities", () => {
    expect(() => parseIssueReadinessSnapshot({ schemaVersion: 1 })).toThrow(
      "snapshot.schemaVersion must be 2",
    );
    expect(() => parseIssueReadinessSnapshot(snapshot([issue(), issue()]))).toThrow(
      "snapshot contains duplicate issue #1",
    );
  });

  test("reports exact metadata, relationship, body, and heading failures", () => {
    const invalid = issue({
      body: "",
      assignees: [],
      labels: ["type: docs", "bug"],
      milestone: null,
      roadmapItemCount: 2,
      roadmapStatuses: ["Todo", "Done"],
    });

    expect(codes(snapshot([invalid]))).toEqual([
      "assignee-count",
      "work-type-count",
      "area-missing",
      "milestone-missing",
      "roadmap-status-count",
      "planning-relationship-missing",
      "body-empty",
      "heading-missing",
      "heading-missing",
    ]);
  });

  test("ignores contribution issues outside the private Roadmap", () => {
    const contribution = issue({
      assignees: [],
      labels: [],
      milestone: null,
      roadmapItemCount: 0,
      roadmapStatuses: [],
      body: "A public contribution report may start with partial context.",
    });

    expect(auditIssueReadiness(snapshot([contribution]))).toEqual([]);
  });

  test("detects dependency cycles and blocker prose drift", () => {
    const first = issue({
      number: 1,
      body: "## Outcome\n\nBlocked by #2 and #3.\n\nPlanning relationship: Standalone-v1.\n\n## Completion proof\n\nComplete.",
      blockedBy: [{ number: 2, state: "OPEN" }],
    });
    const second = issue({
      number: 2,
      body: "## Outcome\n\nIssue #2 is blocked by #1.\n\nPlanning relationship: Standalone-v1.\n\n## Completion proof\n\nComplete.",
      blockedBy: [{ number: 1, state: "OPEN" }],
    });
    const third = issue({ number: 3 });
    const unrelated = issue({
      number: 4,
      body: "## Outcome\n\n#99 is blocked by #100.\n\nPlanning relationship: Standalone-v1.\n\n## Completion proof\n\nComplete.",
    });

    expect(codes(snapshot([first, second, third, unrelated]))).toEqual([
      "prose-blocker-not-native-open",
      "dependency-cycle",
    ]);

    const omitted = issue({
      number: 4,
      blockedBy: [{ number: 3, state: "OPEN" }],
    });
    expect(codes(snapshot([third, omitted]))).toContain("open-blocker-not-mentioned");
  });

  test("detects hierarchy, duplicate appendix, docs-only, and body-limit drift", () => {
    const body = [
      "## Outcome",
      "",
      "- **Delivery role:** PR-sized child. One branch owns 2 native GitHub sub-issues.",
      "",
      "This docs-only issue works through the real Falryn product boundary.",
      "",
      "<!-- shared-delivery-governance-v1 -->",
      "<!-- shared-delivery-governance-v1 -->",
      "<!-- malformed marker",
      "",
      "## Completion proof",
      "",
      "Complete.",
    ].join("\n");
    const invalid = issue({
      body,
      subIssues: [{ number: 2, state: "OPEN" }],
    });

    expect(codes(snapshot([invalid]), { maximumBodyBytes: 32 })).toEqual(
      expect.arrayContaining([
        "body-too-large",
        "stale-child-count",
        "pr-sized-has-children",
        "shared-appendix-duplicate",
        "marker-unbalanced",
        "hierarchy-reciprocity",
        "docs-only-product-completion",
      ]),
    );
  });

  test("detects missing parent references and non-reciprocal hierarchy", () => {
    const child = issue({
      number: 2,
      parent: { number: 1, state: "OPEN" },
      body: "## Outcome\n\nDeliver the child.\n\n## Completion proof\n\nComplete.",
    });
    const parent = issue({ number: 1, subIssues: [] });

    expect(codes(snapshot([child, parent]))).toEqual([
      "parent-reference-missing",
      "hierarchy-reciprocity",
    ]);
  });

  test("checks canonical documentation paths without network access", () => {
    const linked = issue({
      body: [
        "## Outcome",
        "",
        "Planning relationship: Standalone-v1.",
        "Use [Errors](https://github.com/tyldra-org/falryn-docs/blob/main/reference/ERRORS.md).",
        "Use [Missing](https://github.com/yogeshprasad098/falryn-docs/blob/main/guides/MISSING.md).",
        "",
        "## Completion proof",
        "",
        "Complete.",
      ].join("\n"),
    });

    const diagnostics = auditIssueReadiness(snapshot([linked]), {
      documentationPaths: new Set(["reference/ERRORS.md"]),
    });
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: "canonical-document-owner-invalid", issueNumber: 1 }),
    ]);
  });

  test("detects title or milestone changes whose body was not reconciled", () => {
    const previous = snapshot([issue()]);
    const current = snapshot([
      issue({ title: "Renamed fixture", milestone: "v0.5 Web and Computer Use" }),
    ]);

    expect(codes(current, { baseline: previous })).toEqual([
      "body-title-drift",
      "body-milestone-drift",
    ]);
  });
});
