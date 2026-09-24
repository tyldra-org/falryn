/**
 * Roadmap planning contract.
 *
 * Releases are repository milestones titled `v<major>.<minor> <name>` and ordered
 * by that version as a decimal, so `v0.35` falls between `v0.3` and `v0.4`.
 * Priority, Readiness and release exceptions are organization-only issue fields.
 * Status is derived from issue state, closing pull requests and native children.
 */
export const SCHEMA_VERSION = 4 as const;

export const ROADMAP_PRIORITY_OPTIONS = [
  {
    name: "P0",
    description:
      "Immediate: approved active security, data-loss, availability, or release emergency.",
    color: "RED",
  },
  {
    name: "P1",
    description: "High: milestone critical path, safety prerequisite, or multi-outcome unlocker.",
    color: "ORANGE",
  },
  {
    name: "P2",
    description: "Normal: required milestone work outside the critical path.",
    color: "YELLOW",
  },
  {
    name: "P3",
    description: "Low: optional, experimental, polish, or safely deferrable work.",
    color: "GRAY",
  },
  {
    name: "Historical",
    description: "Closed-only: no contemporaneous P0-P3 value; excluded from routing.",
    color: "GRAY",
  },
] as const;

export const ROADMAP_READINESS_OPTIONS = [
  {
    name: "Ready",
    description:
      "Verified PR-sized contract; implementation may start when assigned and unblocked.",
    color: "GREEN",
  },
  {
    name: "Needs Planning",
    description: "Needs source evidence, scope, boundaries, validation, or documentation impact.",
    color: "YELLOW",
  },
  {
    name: "Needs Decision",
    description: "Planning is paused on a named maintainer product, policy, or tradeoff decision.",
    color: "RED",
  },
  {
    name: "Parent",
    description:
      "Open outcome routes through native PR-sized children; never implemented directly.",
    color: "BLUE",
  },
  {
    name: "Historical",
    description: "Closed issue; excluded from current routing.",
    color: "GRAY",
  },
] as const;

/** Organization-only issue fields that hold private planning facts. */
export const ROADMAP_PLANNING_FIELDS = {
  priority: "Roadmap priority",
  readiness: "Readiness",
  releaseException: "Release exception",
} as const;

export const OPEN_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;

export const CLOSED_PRIORITIES = [...OPEN_PRIORITIES, "Historical"] as const;

export const READINESS_VALUES = [
  "Ready",
  "Needs Planning",
  "Needs Decision",
  "Parent",
  "Historical",
] as const;

export const ROADMAP_REPOSITORIES = ["tyldra-org/falryn", "tyldra-org/falryn-docs"] as const;

export type RoadmapIssueState = "OPEN" | "CLOSED";

export type RoadmapPullRequestState = "OPEN" | "CLOSED" | "MERGED";

export type RoadmapPriority = (typeof CLOSED_PRIORITIES)[number];

export type RoadmapReadiness = (typeof READINESS_VALUES)[number];

export type RoadmapStatus = "Todo" | "In Progress" | "Done";

export type RoadmapFieldOption = {
  readonly name: string;
  readonly description: string;
  readonly color: string;
};

/** An organization issue field as captured, with options in their configured order. */
export type RoadmapPlanningField = {
  readonly name: string;
  readonly dataType: string;
  readonly visibility: string;
  readonly options: readonly RoadmapFieldOption[];
};

export type RoadmapMilestone = {
  readonly title: string;
  readonly state: RoadmapIssueState;
};

export type RoadmapRepositoryMilestones = {
  readonly repository: string;
  readonly milestones: readonly RoadmapMilestone[];
};

export type RoadmapRelation = {
  readonly repository: string;
  readonly number: number;
  readonly state: RoadmapIssueState;
};

export type RoadmapClosingPullRequest = {
  readonly repository: string;
  readonly number: number;
  readonly state: RoadmapPullRequestState;
  readonly isDraft: boolean;
  readonly updatedAt: string;
};

/**
 * An issue's planning facts. Present only on Roadmap issues: an issue joins the
 * Roadmap when it carries a Roadmap priority, Readiness or Release exception.
 */
export type RoadmapPlanning = {
  readonly priority: string | null;
  readonly readiness: string | null;
  /** The issue's milestone title. */
  readonly release: string | null;
  readonly releaseException: string | null;
};

export type RoadmapGovernanceIssue = {
  readonly repository: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: RoadmapIssueState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly assignees: readonly string[];
  readonly labels: readonly string[];
  readonly parent: RoadmapRelation | null;
  readonly subIssues: readonly RoadmapRelation[];
  readonly blockedBy: readonly RoadmapRelation[];
  readonly closingPullRequests: readonly RoadmapClosingPullRequest[];
  readonly planning: RoadmapPlanning | null;
};

export type RoadmapRepositoryIssueCount = {
  readonly repository: string;
  readonly count: number;
};

export type RoadmapGovernanceSnapshot = {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly generatedAt: string;
  /** The organization that owns the repositories and planning fields. */
  readonly owner: string;
  readonly repositories: readonly string[];
  readonly repositoryIssueCounts: readonly RoadmapRepositoryIssueCount[];
  readonly planningFields: readonly RoadmapPlanningField[];
  readonly milestones: readonly RoadmapRepositoryMilestones[];
  readonly issues: readonly RoadmapGovernanceIssue[];
};

export type RoadmapGovernanceCode =
  | "planning-field-invalid"
  | "release-catalog-invalid"
  | "release-exception-invalid"
  | "assignee-count"
  | "work-type-count"
  | "area-missing"
  | "target-release-missing"
  | "target-release-closed"
  | "planning-relationship-missing"
  | "relationship-target-missing"
  | "relationship-state-mismatch"
  | "hierarchy-not-reciprocal"
  | "hierarchy-depth-invalid"
  | "hierarchy-target-release-missing"
  | "hierarchy-target-release-mismatch"
  | "priority-invalid"
  | "open-historical-priority"
  | "p0-approval-missing"
  | "readiness-invalid"
  | "readiness-evidence-mismatch"
  | "decision-evidence-missing"
  | "in-progress-readiness-invalid"
  | "parent-readiness-invalid"
  | "closed-readiness-invalid"
  | "in-progress-blocked"
  | "abandoned-closing-pr"
  | "parent-closing-pr-forbidden"
  | "multiple-active-closing-prs"
  | "open-issue-merged-closing-pr"
  | "dependency-cycle"
  | "external-open-blocker"
  | "target-release-order-unknown";

export type RoadmapGovernanceDiagnostic = {
  readonly code: RoadmapGovernanceCode;
  readonly repository: string;
  readonly issueNumber: number;
  readonly message: string;
};

export type RoadmapDeliverySequenceEntry = {
  readonly position: number;
  readonly repository: string;
  readonly issueNumber: number;
  readonly title: string;
  readonly targetRelease: string;
  readonly priority: Exclude<RoadmapPriority, "Historical">;
  readonly readiness: "Ready" | "Needs Planning" | "Needs Decision";
  readonly status: "Todo" | "In Progress";
  readonly openTransitiveDependents: number;
  readonly crossReleasePrerequisite: boolean;
};

export type RoadmapLivenessDecision = {
  readonly repository: string;
  readonly issueNumber: number;
  readonly kind: "parent-continuation" | "open-pull-request" | "stale";
  readonly detail: string;
};

export type RoadmapGovernanceReport = {
  readonly diagnostics: readonly RoadmapGovernanceDiagnostic[];
  readonly deliverySequence: readonly RoadmapDeliverySequenceEntry[];
  readonly liveness: readonly RoadmapLivenessDecision[];
};

export type JsonRecord = { readonly [key: string]: unknown };

export type IssueKey = `${string}#${number}`;
