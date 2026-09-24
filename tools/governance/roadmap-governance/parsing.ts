import { issueKey, sameStrings } from "../roadmap-governance.ts";
import {
  type JsonRecord,
  ROADMAP_REPOSITORIES,
  type RoadmapClosingPullRequest,
  type RoadmapFieldOption,
  type RoadmapGovernanceIssue,
  type RoadmapGovernanceSnapshot,
  type RoadmapIssueState,
  type RoadmapMilestone,
  type RoadmapPlanning,
  type RoadmapPlanningField,
  type RoadmapPullRequestState,
  type RoadmapRelation,
  type RoadmapRepositoryIssueCount,
  type RoadmapRepositoryMilestones,
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
    description: textValue(record.description, `${subject}.description`),
    color: stringValue(record.color, `${subject}.color`),
  };
}

function parsePlanningField(value: unknown, subject: string): RoadmapPlanningField {
  const record = asRecord(value, subject);
  return {
    name: stringValue(record.name, `${subject}.name`),
    dataType: stringValue(record.dataType, `${subject}.dataType`),
    visibility: stringValue(record.visibility, `${subject}.visibility`),
    options: arrayValue(record.options, `${subject}.options`).map((option, index) =>
      parseFieldOption(option, `${subject}.options[${index}]`),
    ),
  };
}

function parseMilestone(value: unknown, subject: string): RoadmapMilestone {
  const record = asRecord(value, subject);
  return {
    title: stringValue(record.title, `${subject}.title`),
    state: issueState(record.state, `${subject}.state`),
  };
}

function parseRepositoryMilestones(value: unknown, subject: string): RoadmapRepositoryMilestones {
  const record = asRecord(value, subject);
  return {
    repository: repositoryValue(record.repository, `${subject}.repository`),
    milestones: arrayValue(record.milestones, `${subject}.milestones`).map((entry, index) =>
      parseMilestone(entry, `${subject}.milestones[${index}]`),
    ),
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

function parsePlanning(value: unknown, subject: string): RoadmapPlanning | null {
  if (value === null) {
    return null;
  }
  const record = asRecord(value, subject);
  const planning: RoadmapPlanning = {
    priority: nullableString(record.priority, `${subject}.priority`),
    readiness: nullableString(record.readiness, `${subject}.readiness`),
    release: nullableString(record.release, `${subject}.release`),
    releaseException: nullableString(record.releaseException, `${subject}.releaseException`),
  };
  if (
    planning.priority === null &&
    planning.readiness === null &&
    planning.releaseException === null
  ) {
    throw new Error(`${subject} must carry a Roadmap field; use null for issues off the Roadmap`);
  }
  return planning;
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
    planning: parsePlanning(record.planning, `${subject}.planning`),
  };
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
  const owner = stringValue(record.owner, "snapshot.owner");
  if (owner !== "tyldra-org") {
    throw new Error("snapshot must target the tyldra-org organization");
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
  const milestones = arrayValue(record.milestones, "snapshot.milestones").map((entry, index) =>
    parseRepositoryMilestones(entry, `snapshot.milestones[${index}]`),
  );
  if (
    milestones.length !== ROADMAP_REPOSITORIES.length ||
    !milestones.every((entry, index) => entry.repository === ROADMAP_REPOSITORIES[index])
  ) {
    throw new Error("snapshot.milestones must cover each canonical repository once");
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
    owner,
    repositories,
    repositoryIssueCounts,
    planningFields: arrayValue(record.planningFields, "snapshot.planningFields").map(
      (field, index) => parsePlanningField(field, `snapshot.planningFields[${index}]`),
    ),
    milestones,
    issues,
  };
}
