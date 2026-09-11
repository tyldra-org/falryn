export const SCHEMA_VERSION = 3 as const;

export const ROADMAP_STATUS_OPTIONS = [
  { name: "Todo", description: "This item hasn't been started", color: "GREEN" },
  {
    name: "In Progress",
    description: "This is actively being worked on",
    color: "YELLOW",
  },
  { name: "Done", description: "This has been completed", color: "PURPLE" },
] as const;

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

export const ROADMAP_REQUIRED_WORKFLOWS = [
  "Auto-add sub-issues to project",
  "Auto-close issue",
  "Item added to project",
  "Item closed",
  "Pull request linked to issue",
  "Pull request merged",
] as const;

export const OPEN_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;

export const CLOSED_PRIORITIES = [...OPEN_PRIORITIES, "Historical"] as const;

export const READINESS_VALUES = [
  "Ready",
  "Needs Planning",
  "Needs Decision",
  "Parent",
  "Historical",
] as const;

const ROADMAP_STATUSES = ["Todo", "In Progress", "Done"] as const;

export const DEFAULT_LIVENESS_GRACE_HOURS = 7 * 24;

export const ROADMAP_REPOSITORIES = ["tyldra-org/falryn", "tyldra-org/falryn-docs"] as const;

export type RoadmapIssueState = "OPEN" | "CLOSED";

export type RoadmapPullRequestState = "OPEN" | "CLOSED" | "MERGED";

export type RoadmapPriority = (typeof CLOSED_PRIORITIES)[number];

export type RoadmapReadiness = (typeof READINESS_VALUES)[number];

export type RoadmapStatus = (typeof ROADMAP_STATUSES)[number];

export type RoadmapFieldOption = {
  readonly name: string;
  readonly description: string;
  readonly color: string;
};

export type RoadmapProjectWorkflow = {
  readonly name: string;
  readonly enabled: boolean;
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

export type RoadmapProjectItem = {
  readonly id: string;
  readonly status: string | null;
  readonly statusUpdatedAt: string | null;
  readonly priority: string | null;
  readonly readiness: string | null;
  readonly targetRelease: string | null;
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
  readonly projectItems: readonly RoadmapProjectItem[];
};

export type RoadmapRepositoryIssueCount = {
  readonly repository: string;
  readonly count: number;
};

export type RoadmapNonIssueProjectItem = {
  readonly id: string;
  readonly contentKind: string;
};

export type RoadmapGovernanceSnapshot = {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly projectOwner: string;
  readonly projectNumber: number;
  readonly projectId: string;
  readonly repositories: readonly string[];
  readonly repositoryIssueCounts: readonly RoadmapRepositoryIssueCount[];
  readonly statusOptions: readonly RoadmapFieldOption[];
  readonly priorityOptions: readonly RoadmapFieldOption[];
  readonly readinessOptions: readonly RoadmapFieldOption[];
  readonly targetReleaseOptions: readonly RoadmapFieldOption[];
  readonly projectPublic: boolean;
  readonly projectWorkflows: readonly RoadmapProjectWorkflow[];
  readonly issues: readonly RoadmapGovernanceIssue[];
  readonly nonIssueProjectItems: readonly RoadmapNonIssueProjectItem[];
};

export type RoadmapGovernanceCode =
  | "project-membership-count"
  | "non-issue-project-item"
  | "project-public"
  | "target-release-field-invalid"
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
  | "status-field-invalid"
  | "status-invalid"
  | "closed-status-invalid"
  | "priority-field-invalid"
  | "priority-invalid"
  | "open-historical-priority"
  | "p0-approval-missing"
  | "readiness-field-invalid"
  | "readiness-invalid"
  | "readiness-evidence-mismatch"
  | "decision-evidence-missing"
  | "in-progress-readiness-invalid"
  | "parent-readiness-invalid"
  | "closed-readiness-invalid"
  | "project-workflow-invalid"
  | "stale-in-progress"
  | "in-progress-blocked"
  | "in-progress-closing-pr-closed"
  | "abandoned-closing-pr"
  | "active-closing-pr-status-mismatch"
  | "parent-closing-pr-forbidden"
  | "multiple-active-closing-prs"
  | "parent-status-mismatch"
  | "parent-in-progress-invalid"
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
  readonly kind: "parent-continuation" | "open-pull-request" | "grace-period" | "stale";
  readonly detail: string;
};

export type RoadmapGovernanceReport = {
  readonly diagnostics: readonly RoadmapGovernanceDiagnostic[];
  readonly deliverySequence: readonly RoadmapDeliverySequenceEntry[];
  readonly liveness: readonly RoadmapLivenessDecision[];
};

export type RoadmapGovernanceOptions = {
  readonly livenessGraceHours?: number;
};

export type JsonRecord = { readonly [key: string]: unknown };

export type IssueKey = `${string}#${number}`;
