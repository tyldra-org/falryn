import { issueKey, sameStrings } from "../roadmap-governance.ts";
import {
  type JsonRecord,
  ROADMAP_REPOSITORIES,
  type RoadmapClosingPullRequest,
  type RoadmapFieldOption,
  type RoadmapGovernanceIssue,
  type RoadmapGovernanceSnapshot,
  type RoadmapIssueState,
  type RoadmapProjectItem,
  type RoadmapProjectWorkflow,
  type RoadmapPullRequestState,
  type RoadmapRelation,
  type RoadmapRepositoryIssueCount,
  SCHEMA_VERSION,
} from "./contracts.ts";

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
