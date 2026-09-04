import { Buffer } from "node:buffer";
import { declaresStandalone } from "./issue-governance-body";

const SCHEMA_VERSION = 2 as const;

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
  "Auto-add to project",
  "Auto-add sub-issues to project",
  "Auto-close issue",
  "Item added to project",
  "Item closed",
  "Pull request linked to issue",
  "Pull request merged",
] as const;

const OPEN_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
const CLOSED_PRIORITIES = [...OPEN_PRIORITIES, "Historical"] as const;
const READINESS_VALUES = [
  "Ready",
  "Needs Planning",
  "Needs Decision",
  "Parent",
  "Historical",
] as const;
const ROADMAP_STATUSES = ["Todo", "In Progress", "Done"] as const;
const MILESTONE_ORDER = [
  "v0.1 Foundation",
  "v0.2 Core Coding Agent",
  "v0.3 Intelligence and Memory",
  "v0.35 Live Product Coding Agent",
  "v0.4 Extensions and Collaboration",
  "v0.5 Web and Computer Use",
  "v0.9 Hardening and Distribution",
  "v1.0 Stable Release",
] as const;
const DEFAULT_LIVENESS_GRACE_HOURS = 7 * 24;
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
  readonly milestone: string | null;
  readonly milestoneState: RoadmapIssueState | null;
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
  readonly projectWorkflows: readonly RoadmapProjectWorkflow[];
  readonly issues: readonly RoadmapGovernanceIssue[];
  readonly nonIssueProjectItems: readonly RoadmapNonIssueProjectItem[];
};

export type RoadmapGovernanceCode =
  | "project-membership-count"
  | "non-issue-project-item"
  | "assignee-count"
  | "work-type-count"
  | "area-missing"
  | "milestone-missing"
  | "milestone-closed"
  | "planning-relationship-missing"
  | "relationship-target-missing"
  | "relationship-state-mismatch"
  | "hierarchy-not-reciprocal"
  | "hierarchy-depth-invalid"
  | "hierarchy-milestone-missing"
  | "hierarchy-milestone-mismatch"
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
  | "milestone-order-unknown";

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
  readonly milestone: string;
  readonly priority: Exclude<RoadmapPriority, "Historical">;
  readonly readiness: "Ready" | "Needs Planning" | "Needs Decision";
  readonly status: "Todo" | "In Progress";
  readonly openTransitiveDependents: number;
  readonly crossMilestonePrerequisite: boolean;
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

type JsonRecord = { readonly [key: string]: unknown };
type IssueKey = `${string}#${number}`;

function asRecord(value: unknown, subject: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${subject} must be an object`);
  }
  return value as JsonRecord;
}

function arrayValue(value: unknown, subject: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${subject} must be an array`);
  }
  return value;
}

function textValue(value: unknown, subject: string): string {
  if (typeof value !== "string") {
    throw new Error(`${subject} must be a string`);
  }
  return value;
}

function stringValue(value: unknown, subject: string): string {
  const text = textValue(value, subject);
  if (text.length === 0) {
    throw new Error(`${subject} must be a non-empty string`);
  }
  return text;
}

function nullableString(value: unknown, subject: string): string | null {
  if (value === null) {
    return null;
  }
  return stringValue(value, subject);
}

function repositoryValue(value: unknown, subject: string): string {
  const repository = stringValue(value, subject);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`${subject} must be an owner/name repository`);
  }
  return repository;
}

function timestampValue(value: unknown, subject: string): string {
  const timestamp = stringValue(value, subject);
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) {
    throw new Error(`${subject} must be an ISO 8601 timestamp with timezone`);
  }
  return new Date(timestamp).toISOString();
}

function nullableTimestamp(value: unknown, subject: string): string | null {
  return value === null ? null : timestampValue(value, subject);
}

function nonNegativeInteger(value: unknown, subject: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${subject} must be a non-negative integer`);
  }
  return value as number;
}

function positiveInteger(value: unknown, subject: string): number {
  const integer = nonNegativeInteger(value, subject);
  if (integer < 1) {
    throw new Error(`${subject} must be a positive integer`);
  }
  return integer;
}

function issueState(value: unknown, subject: string): RoadmapIssueState {
  if (value !== "OPEN" && value !== "CLOSED") {
    throw new Error(`${subject} must be OPEN or CLOSED`);
  }
  return value;
}

function pullRequestState(value: unknown, subject: string): RoadmapPullRequestState {
  if (value !== "OPEN" && value !== "CLOSED" && value !== "MERGED") {
    throw new Error(`${subject} must be OPEN, CLOSED, or MERGED`);
  }
  return value;
}

function stringArray(value: unknown, subject: string): readonly string[] {
  return arrayValue(value, subject).map((entry, index) =>
    stringValue(entry, `${subject}[${index}]`),
  );
}

function parseFieldOption(value: unknown, subject: string): RoadmapFieldOption {
  const record = asRecord(value, subject);
  return {
    name: stringValue(record.name, `${subject}.name`),
    description: stringValue(record.description, `${subject}.description`),
    color: stringValue(record.color, `${subject}.color`),
  };
}

function parseProjectWorkflow(value: unknown, subject: string): RoadmapProjectWorkflow {
  const record = asRecord(value, subject);
  if (typeof record.enabled !== "boolean") {
    throw new Error(`${subject}.enabled must be a boolean`);
  }
  return {
    name: stringValue(record.name, `${subject}.name`),
    enabled: record.enabled,
  };
}

function parseRelation(value: unknown, subject: string): RoadmapRelation {
  const record = asRecord(value, subject);
  return {
    repository: repositoryValue(record.repository, `${subject}.repository`),
    number: positiveInteger(record.number, `${subject}.number`),
    state: issueState(record.state, `${subject}.state`),
  };
}

function parsePullRequest(value: unknown, subject: string): RoadmapClosingPullRequest {
  const record = asRecord(value, subject);
  if (typeof record.isDraft !== "boolean") {
    throw new Error(`${subject}.isDraft must be a boolean`);
  }
  return {
    repository: repositoryValue(record.repository, `${subject}.repository`),
    number: positiveInteger(record.number, `${subject}.number`),
    state: pullRequestState(record.state, `${subject}.state`),
    isDraft: record.isDraft,
    updatedAt: timestampValue(record.updatedAt, `${subject}.updatedAt`),
  };
}

function parseProjectItem(value: unknown, subject: string): RoadmapProjectItem {
  const record = asRecord(value, subject);
  const item: RoadmapProjectItem = {
    id: stringValue(record.id, `${subject}.id`),
    status: nullableString(record.status, `${subject}.status`),
    statusUpdatedAt: nullableTimestamp(record.statusUpdatedAt, `${subject}.statusUpdatedAt`),
    priority: nullableString(record.priority, `${subject}.priority`),
    readiness: nullableString(record.readiness, `${subject}.readiness`),
  };
  if ((item.status === null) !== (item.statusUpdatedAt === null)) {
    throw new Error(`${subject}.status and statusUpdatedAt must both be null or present`);
  }
  return item;
}

function parseIssue(value: unknown, index: number): RoadmapGovernanceIssue {
  const subject = `issues[${index}]`;
  const record = asRecord(value, subject);
  const parent = record.parent;
  const issue: RoadmapGovernanceIssue = {
    repository: repositoryValue(record.repository, `${subject}.repository`),
    number: positiveInteger(record.number, `${subject}.number`),
    title: stringValue(record.title, `${subject}.title`),
    body: textValue(record.body, `${subject}.body`),
    state: issueState(record.state, `${subject}.state`),
    createdAt: timestampValue(record.createdAt, `${subject}.createdAt`),
    updatedAt: timestampValue(record.updatedAt, `${subject}.updatedAt`),
    closedAt: nullableTimestamp(record.closedAt, `${subject}.closedAt`),
    assignees: stringArray(record.assignees, `${subject}.assignees`),
    labels: stringArray(record.labels, `${subject}.labels`),
    milestone: nullableString(record.milestone, `${subject}.milestone`),
    milestoneState:
      record.milestoneState === null
        ? null
        : issueState(record.milestoneState, `${subject}.milestoneState`),
    parent: parent === null ? null : parseRelation(parent, `${subject}.parent`),
    subIssues: arrayValue(record.subIssues, `${subject}.subIssues`).map((entry, relationIndex) =>
      parseRelation(entry, `${subject}.subIssues[${relationIndex}]`),
    ),
    blockedBy: arrayValue(record.blockedBy, `${subject}.blockedBy`).map((entry, relationIndex) =>
      parseRelation(entry, `${subject}.blockedBy[${relationIndex}]`),
    ),
    closingPullRequests: arrayValue(
      record.closingPullRequests,
      `${subject}.closingPullRequests`,
    ).map((entry, pullRequestIndex) =>
      parsePullRequest(entry, `${subject}.closingPullRequests[${pullRequestIndex}]`),
    ),
    projectItems: arrayValue(record.projectItems, `${subject}.projectItems`).map(
      (entry, projectItemIndex) =>
        parseProjectItem(entry, `${subject}.projectItems[${projectItemIndex}]`),
    ),
  };
  if ((issue.milestone === null) !== (issue.milestoneState === null)) {
    throw new Error(`${subject}.milestone and milestoneState must both be null or present`);
  }
  if ((issue.state === "OPEN") !== (issue.closedAt === null)) {
    throw new Error(`${subject}.state and closedAt disagree`);
  }
  if (Date.parse(issue.updatedAt) < Date.parse(issue.createdAt)) {
    throw new Error(`${subject}.updatedAt precedes createdAt`);
  }
  if (issue.closedAt !== null && Date.parse(issue.closedAt) < Date.parse(issue.createdAt)) {
    throw new Error(`${subject}.closedAt precedes createdAt`);
  }
  if (issue.closedAt !== null && Date.parse(issue.closedAt) > Date.parse(issue.updatedAt)) {
    throw new Error(`${subject}.closedAt follows updatedAt`);
  }
  if (issue.closedAt !== null) {
    for (const [index, item] of issue.projectItems.entries()) {
      if (
        item.status === "Done" &&
        item.statusUpdatedAt !== null &&
        Date.parse(item.statusUpdatedAt) < Date.parse(issue.closedAt)
      ) {
        throw new Error(`${subject}.projectItems[${index}].Done precedes closedAt`);
      }
    }
  }
  return issue;
}

export function parseRoadmapGovernanceSnapshot(value: unknown): RoadmapGovernanceSnapshot {
  const record = asRecord(value, "snapshot");
  if (record.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`snapshot.schemaVersion must be ${SCHEMA_VERSION}`);
  }
  const repositories = stringArray(record.repositories, "snapshot.repositories").map(
    (repository, index) => repositoryValue(repository, `snapshot.repositories[${index}]`),
  );
  if (!sameStrings(repositories, ROADMAP_REPOSITORIES)) {
    throw new Error(`snapshot.repositories must be exactly ${ROADMAP_REPOSITORIES.join(", ")}`);
  }
  const projectOwner = stringValue(record.projectOwner, "snapshot.projectOwner");
  const projectNumber = positiveInteger(record.projectNumber, "snapshot.projectNumber");
  if (projectOwner !== "tyldra-org" || projectNumber !== 1) {
    throw new Error("snapshot must target tyldra-org Roadmap Project 1");
  }
  const generatedAt = timestampValue(record.generatedAt, "snapshot.generatedAt");
  const generatedAtMs = Date.parse(generatedAt);
  const issues = arrayValue(record.issues, "snapshot.issues").map(parseIssue);
  const repositoryIssueCounts = arrayValue(
    record.repositoryIssueCounts,
    "snapshot.repositoryIssueCounts",
  ).map((value, index): RoadmapRepositoryIssueCount => {
    const subject = `snapshot.repositoryIssueCounts[${index}]`;
    const count = asRecord(value, subject);
    return {
      repository: repositoryValue(count.repository, `${subject}.repository`),
      count: nonNegativeInteger(count.count, `${subject}.count`),
    };
  });
  if (
    repositoryIssueCounts.length !== ROADMAP_REPOSITORIES.length ||
    !repositoryIssueCounts.every((entry, index) => entry.repository === ROADMAP_REPOSITORIES[index])
  ) {
    throw new Error("snapshot.repositoryIssueCounts must cover each canonical repository once");
  }
  const identities = new Set<string>();
  for (const issue of issues) {
    if (!repositories.includes(issue.repository)) {
      throw new Error(`issue repository is outside snapshot.repositories: ${issue.repository}`);
    }
    const identity = issueKey(issue.repository, issue.number);
    if (identities.has(identity)) {
      throw new Error(`duplicate issue identity: ${identity}`);
    }
    identities.add(identity);
    const observedTimes: Array<readonly [string, string]> = [
      ["createdAt", issue.createdAt],
      ["updatedAt", issue.updatedAt],
    ];
    if (issue.closedAt !== null) {
      observedTimes.push(["closedAt", issue.closedAt]);
    }
    for (const [index, item] of issue.projectItems.entries()) {
      if (item.statusUpdatedAt !== null) {
        observedTimes.push([`projectItems[${index}].statusUpdatedAt`, item.statusUpdatedAt]);
      }
    }
    for (const [index, pullRequest] of issue.closingPullRequests.entries()) {
      observedTimes.push([`closingPullRequests[${index}].updatedAt`, pullRequest.updatedAt]);
    }
    for (const [field, timestamp] of observedTimes) {
      if (Date.parse(timestamp) > generatedAtMs) {
        throw new Error(`snapshot issue ${identity}.${field} follows generatedAt`);
      }
    }
  }
  for (const entry of repositoryIssueCounts) {
    const actual = issues.filter((issue) => issue.repository === entry.repository).length;
    if (actual !== entry.count) {
      throw new Error(
        `snapshot issue count mismatch for ${entry.repository}: expected ${entry.count}, received ${actual}`,
      );
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    projectOwner,
    projectNumber,
    projectId: stringValue(record.projectId, "snapshot.projectId"),
    repositories,
    repositoryIssueCounts,
    statusOptions: arrayValue(record.statusOptions, "snapshot.statusOptions").map((option, index) =>
      parseFieldOption(option, `snapshot.statusOptions[${index}]`),
    ),
    priorityOptions: arrayValue(record.priorityOptions, "snapshot.priorityOptions").map(
      (option, index) => parseFieldOption(option, `snapshot.priorityOptions[${index}]`),
    ),
    readinessOptions: arrayValue(record.readinessOptions, "snapshot.readinessOptions").map(
      (option, index) => parseFieldOption(option, `snapshot.readinessOptions[${index}]`),
    ),
    projectWorkflows: arrayValue(record.projectWorkflows, "snapshot.projectWorkflows").map(
      (workflow, index) => parseProjectWorkflow(workflow, `snapshot.projectWorkflows[${index}]`),
    ),
    issues,
    nonIssueProjectItems: arrayValue(
      record.nonIssueProjectItems,
      "snapshot.nonIssueProjectItems",
    ).map((value, index) => {
      const item = asRecord(value, `snapshot.nonIssueProjectItems[${index}]`);
      return {
        id: stringValue(item.id, `snapshot.nonIssueProjectItems[${index}].id`),
        contentKind: stringValue(
          item.contentKind,
          `snapshot.nonIssueProjectItems[${index}].contentKind`,
        ),
      };
    }),
  };
}

function issueKey(repository: string, number: number): IssueKey {
  return `${repository}#${number}`;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameFieldOptions(
  left: readonly RoadmapFieldOption[],
  right: readonly RoadmapFieldOption[],
): boolean {
  return (
    left.length === right.length &&
    left.every((option, index) => {
      const expected = right[index];
      return (
        expected !== undefined &&
        option.name === expected.name &&
        option.description === expected.description &&
        option.color === expected.color
      );
    })
  );
}

function isOneOf<const Values extends readonly string[]>(
  value: string | null,
  values: Values,
): value is Values[number] {
  return value !== null && values.includes(value);
}

function add(
  diagnostics: RoadmapGovernanceDiagnostic[],
  code: RoadmapGovernanceCode,
  issue: Pick<RoadmapGovernanceIssue, "repository" | "number">,
  message: string,
): void {
  diagnostics.push({ code, repository: issue.repository, issueNumber: issue.number, message });
}

function hasP0Approval(body: string): boolean {
  return /^P0 approval:\s+@[A-Za-z0-9-]+\s+on\s+\d{4}-\d{2}-\d{2}\s+—\s+\S/im.test(body);
}

function hasDecisionRequest(body: string): boolean {
  return /^Decision required:\s+@[A-Za-z0-9-]+\s+—\s+\S/im.test(body);
}

function readyChecklist(
  body: string,
): { readonly checked: number; readonly unchecked: number } | null {
  const match = /^##+\s+Ready checklist\s*$([\s\S]*?)(?=^##+\s|(?![\s\S]))/im.exec(body);
  if (match?.[1] === undefined) {
    return null;
  }
  return {
    checked: [...match[1].matchAll(/^\s*- \[[xX]\]\s+/gm)].length,
    unchecked: [...match[1].matchAll(/^\s*- \[ \]\s+/gm)].length,
  };
}

function openPullRequests(issue: RoadmapGovernanceIssue): readonly RoadmapClosingPullRequest[] {
  return issue.closingPullRequests.filter((pullRequest) => pullRequest.state === "OPEN");
}

function effectiveRelationState(
  relation: RoadmapRelation,
  issues: ReadonlyMap<IssueKey, RoadmapGovernanceIssue>,
): RoadmapIssueState {
  return issues.get(issueKey(relation.repository, relation.number))?.state ?? relation.state;
}

function hoursBetween(earlier: string, later: string): number | null {
  const earlierTime = Date.parse(earlier);
  const laterTime = Date.parse(later);
  if (!Number.isFinite(earlierTime) || !Number.isFinite(laterTime) || laterTime < earlierTime) {
    return null;
  }
  return (laterTime - earlierTime) / 3_600_000;
}

function milestoneRank(milestone: string): number {
  const rank = MILESTONE_ORDER.indexOf(milestone as (typeof MILESTONE_ORDER)[number]);
  return rank === -1 ? Number.MAX_SAFE_INTEGER : rank;
}

function declaresEarlyPrerequisiteMilestone(
  issue: RoadmapGovernanceIssue,
  parent: RoadmapGovernanceIssue,
): boolean {
  if (issue.milestone === null || parent.milestone === null) {
    return false;
  }
  const issueRank = milestoneRank(issue.milestone);
  const parentRank = milestoneRank(parent.milestone);
  if (
    issueRank === Number.MAX_SAFE_INTEGER ||
    parentRank === Number.MAX_SAFE_INTEGER ||
    issueRank >= parentRank
  ) {
    return false;
  }
  const declaration = `Milestone exception: early-prerequisite-v1; parent ${parent.repository}#${parent.number}; child ${issue.milestone}; parent ${parent.milestone}.`;
  return issue.body.split("\n").some((line) => line.trim() === declaration);
}

function priorityRank(priority: string): number {
  const rank = OPEN_PRIORITIES.indexOf(priority as (typeof OPEN_PRIORITIES)[number]);
  return rank === -1 ? Number.MAX_SAFE_INTEGER : rank;
}

function compareText(left: string, right: string): number {
  return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}

function dependencyCycle(
  issues: ReadonlyMap<IssueKey, RoadmapGovernanceIssue>,
  edges: ReadonlyMap<IssueKey, ReadonlySet<IssueKey>>,
): readonly IssueKey[] | null {
  const visiting = new Set<IssueKey>();
  const visited = new Set<IssueKey>();
  const path: IssueKey[] = [];

  const visit = (key: IssueKey): readonly IssueKey[] | null => {
    if (visiting.has(key)) {
      const start = path.indexOf(key);
      return [...path.slice(start), key];
    }
    if (visited.has(key)) {
      return null;
    }
    visiting.add(key);
    path.push(key);
    for (const target of [...(edges.get(key) ?? [])].sort(compareText)) {
      if (!issues.has(target)) {
        continue;
      }
      const cycle = visit(target);
      if (cycle !== null) {
        return cycle;
      }
    }
    path.pop();
    visiting.delete(key);
    visited.add(key);
    return null;
  };

  for (const key of [...issues.keys()].sort(compareText)) {
    const cycle = visit(key);
    if (cycle !== null) {
      return cycle;
    }
  }
  return null;
}

function transitiveDependentCounts(
  issues: ReadonlyMap<IssueKey, RoadmapGovernanceIssue>,
  edges: ReadonlyMap<IssueKey, ReadonlySet<IssueKey>>,
): ReadonlyMap<IssueKey, number> {
  const counts = new Map<IssueKey, number>();
  for (const key of issues.keys()) {
    const seen = new Set<IssueKey>();
    const stack = [...(edges.get(key) ?? [])];
    while (stack.length > 0) {
      const target = stack.pop();
      if (target === undefined || seen.has(target) || !issues.has(target)) {
        continue;
      }
      seen.add(target);
      stack.push(...(edges.get(target) ?? []));
    }
    counts.set(key, seen.size);
  }
  return counts;
}

function validParentContinuation(
  issue: RoadmapGovernanceIssue,
  issues: ReadonlyMap<IssueKey, RoadmapGovernanceIssue>,
): boolean {
  let hasStartedChild = false;
  for (const relation of issue.subIssues) {
    const child = issues.get(issueKey(relation.repository, relation.number));
    if (child === undefined) {
      continue;
    }
    if (child.state === "CLOSED") {
      hasStartedChild = true;
      continue;
    }
    const status = child.projectItems[0]?.status;
    if (status === "In Progress" || status === "Done") {
      hasStartedChild = true;
    }
  }
  return hasStartedChild;
}

function sequence(
  issues: ReadonlyMap<IssueKey, RoadmapGovernanceIssue>,
): readonly RoadmapDeliverySequenceEntry[] {
  const edges = new Map<IssueKey, Set<IssueKey>>();
  const indegree = new Map<IssueKey, number>();
  const crossMilestonePrerequisites = new Set<IssueKey>();
  for (const key of issues.keys()) {
    edges.set(key, new Set());
    indegree.set(key, 0);
  }
  const connect = (source: IssueKey, target: IssueKey): void => {
    if (!issues.has(source) || !issues.has(target) || edges.get(source)?.has(target) === true) {
      return;
    }
    edges.get(source)?.add(target);
    indegree.set(target, (indegree.get(target) ?? 0) + 1);
  };
  for (const [key, issue] of issues) {
    for (const blocker of issue.blockedBy) {
      const blockerKey = issueKey(blocker.repository, blocker.number);
      if (issues.has(blockerKey)) {
        connect(blockerKey, key);
      } else if (blocker.state === "OPEN") {
        indegree.set(key, (indegree.get(key) ?? 0) + 1);
      }
      const blockerIssue = issues.get(blockerKey);
      if (
        blockerIssue !== undefined &&
        blockerIssue.milestone !== null &&
        issue.milestone !== null &&
        milestoneRank(blockerIssue.milestone) > milestoneRank(issue.milestone)
      ) {
        crossMilestonePrerequisites.add(blockerKey);
      }
    }
    for (const child of issue.subIssues) {
      const childKey = issueKey(child.repository, child.number);
      if (issues.has(childKey)) {
        connect(childKey, key);
      }
    }
  }
  const dependentCounts = transitiveDependentCounts(issues, edges);
  const isActive = (issue: RoadmapGovernanceIssue): boolean =>
    issue.projectItems[0]?.status === "In Progress" &&
    issue.subIssues.length === 0 &&
    openPullRequests(issue).length > 0;
  const compareKeys = (leftKey: IssueKey, rightKey: IssueKey): number => {
    const left = issues.get(leftKey);
    const right = issues.get(rightKey);
    if (left === undefined || right === undefined) {
      return compareText(leftKey, rightKey);
    }
    const activeDifference = Number(isActive(right)) - Number(isActive(left));
    if (activeDifference !== 0) {
      return activeDifference;
    }
    const p0Difference =
      Number(right.projectItems[0]?.priority === "P0") -
      Number(left.projectItems[0]?.priority === "P0");
    if (p0Difference !== 0) {
      return p0Difference;
    }
    const milestoneDifference =
      milestoneRank(left.milestone ?? "") - milestoneRank(right.milestone ?? "");
    if (milestoneDifference !== 0) {
      return milestoneDifference;
    }
    const priorityDifference =
      priorityRank(left.projectItems[0]?.priority ?? "") -
      priorityRank(right.projectItems[0]?.priority ?? "");
    if (priorityDifference !== 0) {
      return priorityDifference;
    }
    const dependentDifference =
      (dependentCounts.get(rightKey) ?? 0) - (dependentCounts.get(leftKey) ?? 0);
    if (dependentDifference !== 0) {
      return dependentDifference;
    }
    const createdDifference = Date.parse(left.createdAt) - Date.parse(right.createdAt);
    if (createdDifference !== 0) {
      return createdDifference;
    }
    const repositoryDifference = compareText(left.repository, right.repository);
    return repositoryDifference !== 0 ? repositoryDifference : left.number - right.number;
  };
  const frontier = [...issues.keys()].filter((key) => indegree.get(key) === 0).sort(compareKeys);
  const ordered: IssueKey[] = [];
  while (frontier.length > 0) {
    const key = frontier.shift();
    if (key === undefined) {
      break;
    }
    ordered.push(key);
    for (const target of [...(edges.get(key) ?? [])].sort(compareText)) {
      const nextDegree = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, nextDegree);
      if (nextDegree === 0) {
        frontier.push(target);
        frontier.sort(compareKeys);
      }
    }
  }

  const result: RoadmapDeliverySequenceEntry[] = [];
  for (const key of ordered) {
    const issue = issues.get(key);
    const item = issue?.projectItems[0];
    if (
      issue === undefined ||
      item === undefined ||
      issue.subIssues.length > 0 ||
      issue.milestone === null ||
      issue.milestoneState !== "OPEN" ||
      !isOneOf(item.priority, OPEN_PRIORITIES) ||
      (item.readiness !== "Ready" &&
        item.readiness !== "Needs Planning" &&
        item.readiness !== "Needs Decision") ||
      (item.status !== "Todo" && item.status !== "In Progress")
    ) {
      continue;
    }
    result.push({
      position: result.length + 1,
      repository: issue.repository,
      issueNumber: issue.number,
      title: issue.title,
      milestone: issue.milestone,
      priority: item.priority,
      readiness: item.readiness,
      status: item.status,
      openTransitiveDependents: dependentCounts.get(key) ?? 0,
      crossMilestonePrerequisite: crossMilestonePrerequisites.has(key),
    });
  }
  return result;
}

export function analyzeRoadmapGovernance(
  snapshot: RoadmapGovernanceSnapshot,
  options: RoadmapGovernanceOptions = {},
): RoadmapGovernanceReport {
  const graceHours = options.livenessGraceHours ?? DEFAULT_LIVENESS_GRACE_HOURS;
  if (!Number.isFinite(graceHours) || graceHours < 0) {
    throw new Error("livenessGraceHours must be a non-negative finite number");
  }
  const diagnostics: RoadmapGovernanceDiagnostic[] = [];
  const liveness: RoadmapLivenessDecision[] = [];
  const allIssues = new Map<IssueKey, RoadmapGovernanceIssue>(
    snapshot.issues.map((issue) => [issueKey(issue.repository, issue.number), issue]),
  );
  const issues = new Map<IssueKey, RoadmapGovernanceIssue>(
    [...allIssues].filter(([, issue]) => issue.state === "OPEN"),
  );

  if (!sameFieldOptions(snapshot.statusOptions, ROADMAP_STATUS_OPTIONS)) {
    diagnostics.push({
      code: "status-field-invalid",
      repository: "*",
      issueNumber: 0,
      message: "Status option names, descriptions, colors, and order do not match the contract",
    });
  }
  if (!sameFieldOptions(snapshot.priorityOptions, ROADMAP_PRIORITY_OPTIONS)) {
    diagnostics.push({
      code: "priority-field-invalid",
      repository: "*",
      issueNumber: 0,
      message: "Priority option names, descriptions, colors, and order do not match the contract",
    });
  }
  if (!sameFieldOptions(snapshot.readinessOptions, ROADMAP_READINESS_OPTIONS)) {
    diagnostics.push({
      code: "readiness-field-invalid",
      repository: "*",
      issueNumber: 0,
      message: "Readiness option names, descriptions, colors, and order do not match the contract",
    });
  }
  for (const name of ROADMAP_REQUIRED_WORKFLOWS) {
    const matches = snapshot.projectWorkflows.filter((workflow) => workflow.name === name);
    if (matches.length !== 1 || matches[0]?.enabled !== true) {
      diagnostics.push({
        code: "project-workflow-invalid",
        repository: "*",
        issueNumber: 0,
        message: `required Project workflow must exist exactly once and be enabled: ${name}`,
      });
    }
  }
  for (const item of snapshot.nonIssueProjectItems) {
    diagnostics.push({
      code: "non-issue-project-item",
      repository: snapshot.projectOwner,
      issueNumber: 0,
      message: `Project item ${item.id} has non-issue content kind ${item.contentKind}`,
    });
  }

  for (const issue of [...snapshot.issues].sort((left, right) => {
    const repositoryDifference = compareText(left.repository, right.repository);
    return repositoryDifference !== 0 ? repositoryDifference : left.number - right.number;
  })) {
    if (issue.projectItems.length !== 1) {
      add(
        diagnostics,
        "project-membership-count",
        issue,
        `expected one Project item; found ${issue.projectItems.length}`,
      );
      continue;
    }
    const item = issue.projectItems[0];
    if (item === undefined) {
      continue;
    }

    if (issue.state === "OPEN") {
      const workTypes = issue.labels.filter(
        (label) => label === "bug" || label.startsWith("type:"),
      );
      if (issue.assignees.length !== 1) {
        add(
          diagnostics,
          "assignee-count",
          issue,
          `expected one assignee; found ${issue.assignees.length}`,
        );
      }
      if (workTypes.length !== 1) {
        add(
          diagnostics,
          "work-type-count",
          issue,
          `expected one work type; found ${workTypes.length}`,
        );
      }
      if (!issue.labels.some((label) => label.startsWith("area:"))) {
        add(diagnostics, "area-missing", issue, "missing area:* label");
      }
      if (issue.milestone === null || issue.milestoneState === null) {
        add(diagnostics, "milestone-missing", issue, "missing milestone");
      } else if (issue.milestoneState === "CLOSED") {
        add(
          diagnostics,
          "milestone-closed",
          issue,
          `open issue belongs to closed milestone ${issue.milestone}`,
        );
      } else if (milestoneRank(issue.milestone) === Number.MAX_SAFE_INTEGER) {
        add(
          diagnostics,
          "milestone-order-unknown",
          issue,
          `unknown milestone order: ${issue.milestone}`,
        );
      }
      if (issue.parent !== null && issue.subIssues.length > 0) {
        add(
          diagnostics,
          "hierarchy-depth-invalid",
          issue,
          "issue cannot have both a native parent and native subissues",
        );
      }
      if (
        issue.parent === null &&
        issue.subIssues.length === 0 &&
        !declaresStandalone(issue.body)
      ) {
        add(
          diagnostics,
          "planning-relationship-missing",
          issue,
          "missing native parent or explicit Standalone declaration",
        );
      }
      if (item.status !== "Todo" && item.status !== "In Progress") {
        add(
          diagnostics,
          "status-invalid",
          issue,
          `open issue status must be Todo or In Progress; found ${item.status ?? "none"}`,
        );
      }
      if (item.priority === "Historical") {
        add(
          diagnostics,
          "open-historical-priority",
          issue,
          "open issue cannot use Historical priority",
        );
      } else if (!isOneOf(item.priority, OPEN_PRIORITIES)) {
        add(
          diagnostics,
          "priority-invalid",
          issue,
          `open issue priority must be P0-P3; found ${item.priority ?? "none"}`,
        );
      } else if (item.priority === "P0" && !hasP0Approval(issue.body)) {
        add(
          diagnostics,
          "p0-approval-missing",
          issue,
          "P0 requires `P0 approval: @owner on YYYY-MM-DD — reason` in the issue body",
        );
      }
      if (!isOneOf(item.readiness, READINESS_VALUES)) {
        add(
          diagnostics,
          "readiness-invalid",
          issue,
          `missing or invalid Readiness: ${item.readiness ?? "none"}`,
        );
      } else if (issue.subIssues.length > 0 && item.readiness !== "Parent") {
        add(
          diagnostics,
          "parent-readiness-invalid",
          issue,
          `open parent must use Parent readiness; found ${item.readiness}`,
        );
      } else if (issue.subIssues.length === 0 && item.readiness === "Ready") {
        const checklist = readyChecklist(issue.body);
        const metadataReady =
          issue.assignees.length === 1 &&
          workTypes.length === 1 &&
          issue.labels.some((label) => label.startsWith("area:")) &&
          issue.milestone !== null &&
          issue.milestoneState === "OPEN" &&
          (issue.parent !== null || declaresStandalone(issue.body));
        if (
          !metadataReady ||
          checklist === null ||
          checklist.checked === 0 ||
          checklist.unchecked > 0
        ) {
          add(
            diagnostics,
            "readiness-evidence-mismatch",
            issue,
            "Ready requires complete metadata and a non-empty fully checked Ready checklist",
          );
        }
      } else if (
        issue.subIssues.length === 0 &&
        item.readiness === "Needs Decision" &&
        !hasDecisionRequest(issue.body)
      ) {
        add(
          diagnostics,
          "decision-evidence-missing",
          issue,
          "Needs Decision requires `Decision required: @owner — question` in the issue body",
        );
      } else if (
        issue.subIssues.length === 0 &&
        item.readiness !== "Ready" &&
        item.readiness !== "Needs Planning" &&
        item.readiness !== "Needs Decision"
      ) {
        add(
          diagnostics,
          "readiness-invalid",
          issue,
          `open leaf must use Ready, Needs Planning, or Needs Decision; found ${item.readiness}`,
        );
      }
      if (
        issue.subIssues.length === 0 &&
        item.status === "In Progress" &&
        item.readiness !== "Ready"
      ) {
        add(
          diagnostics,
          "in-progress-readiness-invalid",
          issue,
          `In Progress leaf must remain Ready; found ${item.readiness ?? "none"}`,
        );
      }

      const activeClosingPullRequests = openPullRequests(issue);
      if (activeClosingPullRequests.length > 1) {
        add(
          diagnostics,
          "multiple-active-closing-prs",
          issue,
          `expected at most one open closing pull request; found ${activeClosingPullRequests.length}`,
        );
      }
      if (issue.subIssues.length > 0 && issue.closingPullRequests.length > 0) {
        add(
          diagnostics,
          "parent-closing-pr-forbidden",
          issue,
          "parent outcome cannot own a closing pull request",
        );
      } else if (issue.subIssues.length === 0 && activeClosingPullRequests.length > 0) {
        if (item.status !== "In Progress") {
          add(
            diagnostics,
            "active-closing-pr-status-mismatch",
            issue,
            "leaf with an open closing pull request must be In Progress",
          );
        }
      }
      if (
        issue.subIssues.length > 0 &&
        item.status === "Todo" &&
        issue.subIssues.some((relation) => {
          const child = allIssues.get(issueKey(relation.repository, relation.number));
          return (
            child !== undefined &&
            (child.state === "CLOSED" ||
              child.projectItems[0]?.status === "In Progress" ||
              child.projectItems[0]?.status === "Done" ||
              openPullRequests(child).length > 0)
          );
        })
      ) {
        add(
          diagnostics,
          "parent-status-mismatch",
          issue,
          "Todo parent has an active native child and must be In Progress",
        );
      }

      if (item.status === "In Progress") {
        const openBlockers = issue.blockedBy.filter(
          (blocker) => effectiveRelationState(blocker, allIssues) === "OPEN",
        );
        if (openBlockers.length > 0) {
          const detail = `In Progress issue has open blocker ${openBlockers
            .map((blocker) => `${blocker.repository}#${blocker.number}`)
            .sort(compareText)
            .join(", ")}`;
          liveness.push({
            repository: issue.repository,
            issueNumber: issue.number,
            kind: "stale",
            detail,
          });
          add(diagnostics, "in-progress-blocked", issue, detail);
        } else if (issue.subIssues.length > 0) {
          if (validParentContinuation(issue, allIssues)) {
            liveness.push({
              repository: issue.repository,
              issueNumber: issue.number,
              kind: "parent-continuation",
              detail: issue.subIssues.some(
                (relation) =>
                  allIssues.get(issueKey(relation.repository, relation.number))?.state === "OPEN",
              )
                ? "open parent has started and remaining children"
                : "all native children are closed; integrated verification remains",
            });
          } else {
            add(
              diagnostics,
              "parent-in-progress-invalid",
              issue,
              "In Progress parent has no started child plus remaining open child",
            );
          }
        } else if (openPullRequests(issue).length > 0) {
          liveness.push({
            repository: issue.repository,
            issueNumber: issue.number,
            kind: "open-pull-request",
            detail: "open closing pull request proves active delivery",
          });
        } else if (
          issue.closingPullRequests.some((pullRequest) => pullRequest.state === "MERGED")
        ) {
          liveness.push({
            repository: issue.repository,
            issueNumber: issue.number,
            kind: "stale",
            detail: "linked closing pull request merged while the issue remains open",
          });
        } else if (
          issue.closingPullRequests.some((pullRequest) => pullRequest.state === "CLOSED")
        ) {
          const detail = "linked closing pull request closed without merge or an open replacement";
          liveness.push({
            repository: issue.repository,
            issueNumber: issue.number,
            kind: "stale",
            detail,
          });
          add(diagnostics, "in-progress-closing-pr-closed", issue, detail);
        } else {
          const elapsed =
            item.statusUpdatedAt === null
              ? null
              : hoursBetween(item.statusUpdatedAt, snapshot.generatedAt);
          if (elapsed !== null && elapsed <= graceHours) {
            liveness.push({
              repository: issue.repository,
              issueNumber: issue.number,
              kind: "grace-period",
              detail: `${elapsed.toFixed(1)} hours without an open closing pull request`,
            });
          } else {
            liveness.push({
              repository: issue.repository,
              issueNumber: issue.number,
              kind: "stale",
              detail:
                elapsed === null
                  ? "missing or invalid Status timestamp"
                  : `${elapsed.toFixed(1)} hours without an open closing pull request`,
            });
            add(
              diagnostics,
              "stale-in-progress",
              issue,
              liveness.at(-1)?.detail ?? "stale In Progress issue",
            );
          }
        }
      }
      if (
        item.status !== "In Progress" &&
        openPullRequests(issue).length === 0 &&
        issue.closingPullRequests.some((pullRequest) => pullRequest.state === "CLOSED")
      ) {
        add(
          diagnostics,
          "abandoned-closing-pr",
          issue,
          "linked closing pull request closed without merge or an open replacement",
        );
      }
      if (issue.closingPullRequests.some((pullRequest) => pullRequest.state === "MERGED")) {
        add(
          diagnostics,
          "open-issue-merged-closing-pr",
          issue,
          "open issue has a merged closing pull request",
        );
      }
      for (const blocker of issue.blockedBy) {
        if (
          blocker.state === "OPEN" &&
          !allIssues.has(issueKey(blocker.repository, blocker.number))
        ) {
          add(
            diagnostics,
            "external-open-blocker",
            issue,
            `open blocker ${blocker.repository}#${blocker.number} is outside the audited repository set`,
          );
        }
      }
    } else {
      if (item.status !== "Done") {
        add(
          diagnostics,
          "closed-status-invalid",
          issue,
          `closed issue status must be Done; found ${item.status ?? "none"}`,
        );
      }
      if (!isOneOf(item.priority, CLOSED_PRIORITIES)) {
        add(
          diagnostics,
          "priority-invalid",
          issue,
          `closed issue priority must be P0-P3 or Historical; found ${item.priority ?? "none"}`,
        );
      }
      if (item.readiness !== "Historical") {
        add(
          diagnostics,
          "closed-readiness-invalid",
          issue,
          `closed issue Readiness must be Historical; found ${item.readiness ?? "none"}`,
        );
      }
    }
  }

  for (const issue of snapshot.issues) {
    const sourceKey = issueKey(issue.repository, issue.number);
    const validateRelation = (relation: RoadmapRelation, kind: string): void => {
      const targetKey = issueKey(relation.repository, relation.number);
      const target = allIssues.get(targetKey);
      if (target === undefined) {
        if (kind !== "blocker") {
          add(
            diagnostics,
            "relationship-target-missing",
            issue,
            `${kind} ${targetKey} is outside the audited issue set`,
          );
        }
        return;
      }
      if (relation.state !== target.state) {
        add(
          diagnostics,
          "relationship-state-mismatch",
          issue,
          `${kind} ${targetKey} reports ${relation.state}; issue record is ${target.state}`,
        );
      }
    };
    if (issue.parent !== null) {
      validateRelation(issue.parent, "parent");
      const parent = allIssues.get(issueKey(issue.parent.repository, issue.parent.number));
      if (
        parent !== undefined &&
        !parent.subIssues.some((child) => issueKey(child.repository, child.number) === sourceKey)
      ) {
        add(
          diagnostics,
          "hierarchy-not-reciprocal",
          issue,
          `parent ${issue.parent.repository}#${issue.parent.number} does not list this issue`,
        );
      }
    }
    for (const child of issue.subIssues) {
      validateRelation(child, "child");
      const target = allIssues.get(issueKey(child.repository, child.number));
      if (target !== undefined && (issue.milestone === null || target.milestone === null)) {
        add(
          diagnostics,
          "hierarchy-milestone-missing",
          target,
          `native child or parent milestone is missing for ${sourceKey}`,
        );
      } else if (
        target !== undefined &&
        issue.milestone !== null &&
        target.milestone !== null &&
        target.milestone !== issue.milestone &&
        !declaresEarlyPrerequisiteMilestone(target, issue)
      ) {
        add(
          diagnostics,
          "hierarchy-milestone-mismatch",
          target,
          `milestone ${target.milestone} differs from parent milestone ${issue.milestone}`,
        );
      }
      if (
        target?.state === "OPEN" &&
        (target.parent === null ||
          issueKey(target.parent.repository, target.parent.number) !== sourceKey)
      ) {
        add(
          diagnostics,
          "hierarchy-not-reciprocal",
          issue,
          `child ${child.repository}#${child.number} does not name this issue as parent`,
        );
      }
    }
    for (const blocker of issue.blockedBy) {
      validateRelation(blocker, "blocker");
    }
  }

  const openEdges = new Map<IssueKey, Set<IssueKey>>();
  for (const key of issues.keys()) {
    openEdges.set(key, new Set());
  }
  for (const [key, issue] of issues) {
    for (const blocker of issue.blockedBy) {
      const blockerKey = issueKey(blocker.repository, blocker.number);
      if (issues.has(blockerKey)) {
        openEdges.get(blockerKey)?.add(key);
      }
    }
    for (const child of issue.subIssues) {
      const childKey = issueKey(child.repository, child.number);
      if (issues.has(childKey)) {
        openEdges.get(childKey)?.add(key);
      }
    }
  }
  const cycle = dependencyCycle(issues, openEdges);
  if (cycle !== null) {
    const first = cycle[0] ?? "*#0";
    const separator = first.lastIndexOf("#");
    diagnostics.push({
      code: "dependency-cycle",
      repository: separator === -1 ? "*" : first.slice(0, separator),
      issueNumber: separator === -1 ? 0 : Number(first.slice(separator + 1)),
      message: `open dependency/hierarchy cycle: ${cycle.join(" -> ")}`,
    });
  }

  diagnostics.sort((left, right) => {
    const repositoryDifference = compareText(left.repository, right.repository);
    if (repositoryDifference !== 0) {
      return repositoryDifference;
    }
    return left.issueNumber - right.issueNumber || compareText(left.code, right.code);
  });

  return {
    diagnostics,
    deliverySequence: diagnostics.length === 0 ? sequence(issues) : [],
    liveness: liveness.sort((left, right) => {
      const repositoryDifference = compareText(left.repository, right.repository);
      return repositoryDifference !== 0
        ? repositoryDifference
        : left.issueNumber - right.issueNumber;
    }),
  };
}
