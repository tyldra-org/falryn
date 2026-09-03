import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  analyzeRoadmapGovernance,
  parseRoadmapGovernanceSnapshot,
  ROADMAP_REPOSITORIES,
  type RoadmapGovernanceIssue,
  type RoadmapGovernanceSnapshot,
  type RoadmapNonIssueProjectItem,
  type RoadmapProjectItem,
  type RoadmapPullRequestState,
  type RoadmapRelation,
} from "./roadmap-governance";

const execFileAsync = promisify(execFile);

type JsonRecord = { readonly [key: string]: unknown };
type CliOptions = {
  readonly source:
    | { readonly kind: "live"; readonly repositories: readonly string[] }
    | { readonly kind: "snapshot"; readonly path: string };
  readonly projectOwner: string;
  readonly projectNumber: number;
  readonly snapshotOut: string | null;
  readonly json: boolean;
  readonly livenessGraceHours: number;
};

type LiveProject = {
  readonly id: string;
  readonly statusOptions: readonly string[];
  readonly priorityOptions: readonly string[];
  readonly readinessOptions: readonly string[];
  readonly itemsByContentId: ReadonlyMap<string, readonly RoadmapProjectItem[]>;
  readonly nonIssueProjectItems: readonly RoadmapNonIssueProjectItem[];
};

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

function stringValue(value: unknown, subject: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${subject} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, subject: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return stringValue(value, subject);
}

function positiveInteger(value: unknown, subject: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${subject} must be a positive integer`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, subject: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${subject} must be a non-negative integer`);
  }
  return value as number;
}

function booleanValue(value: unknown, subject: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${subject} must be a boolean`);
  }
  return value;
}

function completeConnectionNodes(value: unknown, subject: string): readonly unknown[] {
  const connection = asRecord(value, subject);
  const totalCount = nonNegativeInteger(connection.totalCount, `${subject}.totalCount`);
  const nodes = arrayValue(connection.nodes, `${subject}.nodes`);
  if (totalCount !== nodes.length) {
    throw new Error(
      `${subject} is truncated: expected ${totalCount} nodes, received ${nodes.length}`,
    );
  }
  return nodes;
}

async function runGh(args: readonly string[]): Promise<unknown> {
  const { stdout } = await execFileAsync("gh", ["api", "graphql", ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
  const payload: unknown = JSON.parse(stdout);
  const record = asRecord(payload, "GitHub GraphQL response");
  if (Array.isArray(record.errors) && record.errors.length > 0) {
    throw new Error(`GitHub GraphQL errors: ${JSON.stringify(record.errors)}`);
  }
  return record;
}

function parseRepository(value: string): { readonly owner: string; readonly name: string } {
  const [owner, name, extra] = value.split("/");
  if (
    owner === undefined ||
    name === undefined ||
    extra !== undefined ||
    owner === "" ||
    name === ""
  ) {
    throw new Error(`repository must use owner/name: ${value}`);
  }
  return { owner, name };
}

function relationFromGraphQl(value: unknown, subject: string): RoadmapRelation {
  const record = asRecord(value, subject);
  const repository = asRecord(record.repository, `${subject}.repository`);
  const state = stringValue(record.state, `${subject}.state`);
  if (state !== "OPEN" && state !== "CLOSED") {
    throw new Error(`${subject}.state must be OPEN or CLOSED`);
  }
  return {
    repository: stringValue(repository.nameWithOwner, `${subject}.repository.nameWithOwner`),
    number: positiveInteger(record.number, `${subject}.number`),
    state,
  };
}

export function fieldValues(value: unknown, subject: string): ReadonlyMap<string, JsonRecord> {
  const nodes = completeConnectionNodes(value, subject);
  const result = new Map<string, JsonRecord>();
  for (const [index, node] of nodes.entries()) {
    const record = asRecord(node, `${subject}.nodes[${index}]`);
    if (record.field === null || record.field === undefined) {
      continue;
    }
    const field = asRecord(record.field, `${subject}.nodes[${index}].field`);
    const name = nullableString(field.name, `${subject}.nodes[${index}].field.name`);
    if (name !== null) {
      if (result.has(name)) {
        throw new Error(`${subject} contains duplicate field name ${name}`);
      }
      result.set(name, record);
    }
  }
  return result;
}

function projectItemFromGraphQl(
  value: unknown,
  subject: string,
): {
  readonly contentId: string | null;
  readonly contentKind: string;
  readonly item: RoadmapProjectItem;
} {
  const record = asRecord(value, subject);
  const contentKind = stringValue(record.type, `${subject}.type`);
  const content = record.content === null ? null : asRecord(record.content, `${subject}.content`);
  const values = fieldValues(record.fieldValues, `${subject}.fieldValues`);
  const status = values.get("Status");
  const priority = values.get("Priority");
  const readiness = values.get("Readiness");
  return {
    contentId: content === null ? null : nullableString(content.id, `${subject}.content.id`),
    contentKind,
    item: {
      id: stringValue(record.id, `${subject}.id`),
      status: status === undefined ? null : nullableString(status.name, `${subject}.Status.name`),
      statusUpdatedAt:
        status === undefined
          ? null
          : nullableString(status.updatedAt, `${subject}.Status.updatedAt`),
      priority:
        priority === undefined ? null : nullableString(priority.name, `${subject}.Priority.name`),
      readiness:
        readiness === undefined
          ? null
          : nullableString(readiness.name, `${subject}.Readiness.name`),
    },
  };
}

async function loadProject(projectOwner: string, projectNumber: number): Promise<LiveProject> {
  const query = `query($after:String) {
    repositoryOwner(login:${JSON.stringify(projectOwner)}) {
      ... on Organization { projectV2(number:${projectNumber}) { ...Project } }
      ... on User { projectV2(number:${projectNumber}) { ...Project } }
    }
  }
  fragment Project on ProjectV2 {
    id
    fields(first:100) {
      totalCount
      nodes {
        ... on ProjectV2Field { id name dataType }
        ... on ProjectV2SingleSelectField { id name dataType options { id name } }
      }
    }
    items(first:100,after:$after) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        id type
        content {
          ... on Issue { id }
          ... on PullRequest { id }
          ... on DraftIssue { id }
        }
        fieldValues(first:100) {
          totalCount
          nodes {
            ... on ProjectV2ItemFieldSingleSelectValue {
              name updatedAt
              field { ... on ProjectV2SingleSelectField { id name } }
            }
          }
        }
      }
    }
  }`;
  let after: string | null = null;
  let projectId: string | null = null;
  let statusOptions: readonly string[] = [];
  let priorityOptions: readonly string[] = [];
  let readinessOptions: readonly string[] = [];
  const observedFields = new Map<
    string,
    { readonly id: string; readonly options: readonly string[] }
  >();
  let expectedItems: number | null = null;
  const itemRecords: unknown[] = [];
  do {
    const args = ["-f", `query=${query}`];
    if (after !== null) {
      args.push("-f", `after=${after}`);
    }
    const payload = asRecord(await runGh(args), "Roadmap response");
    const data = asRecord(payload.data, "Roadmap response.data");
    const owner = asRecord(data.repositoryOwner, "Roadmap owner");
    const project = asRecord(owner.projectV2, "Roadmap project");
    projectId ??= stringValue(project.id, "Roadmap project.id");
    const fields = completeConnectionNodes(project.fields, "Roadmap project.fields");
    for (const [index, value] of fields.entries()) {
      const field = asRecord(value, `Roadmap project.fields.nodes[${index}]`);
      const name = nullableString(field.name, `Roadmap project.fields.nodes[${index}].name`);
      if (name !== "Status" && name !== "Priority" && name !== "Readiness") {
        continue;
      }
      const id = stringValue(field.id, `Roadmap project field ${name}.id`);
      const options = arrayValue(field.options, `Roadmap project field ${name}.options`).map(
        (option, optionIndex) =>
          stringValue(
            asRecord(option, `Roadmap project field ${name}.options[${optionIndex}]`).name,
            `Roadmap project field ${name}.options[${optionIndex}].name`,
          ),
      );
      const observed = observedFields.get(name);
      if (observed !== undefined && observed.id !== id) {
        throw new Error(`Roadmap contains duplicate ${name} fields`);
      }
      if (observed !== undefined && observed.options.join("\0") !== options.join("\0")) {
        throw new Error(`Roadmap field ${name} changed while it was being collected`);
      }
      observedFields.set(name, { id, options });
      if (name === "Status") {
        statusOptions = options;
      } else if (name === "Priority") {
        priorityOptions = options;
      } else {
        readinessOptions = options;
      }
    }
    const items = asRecord(project.items, "Roadmap project.items");
    expectedItems ??= nonNegativeInteger(items.totalCount, "Roadmap project.items.totalCount");
    itemRecords.push(...arrayValue(items.nodes, "Roadmap project.items.nodes"));
    const pageInfo = asRecord(items.pageInfo, "Roadmap project.items.pageInfo");
    if (pageInfo.hasNextPage !== true) {
      after = null;
    } else {
      after = stringValue(pageInfo.endCursor, "Roadmap project.items.pageInfo.endCursor");
    }
  } while (after !== null);

  if (projectId === null || expectedItems === null || expectedItems !== itemRecords.length) {
    throw new Error(
      `Roadmap item pagination mismatch: expected ${expectedItems ?? "unknown"}, received ${itemRecords.length}`,
    );
  }
  const mutableItems = new Map<string, RoadmapProjectItem[]>();
  const nonIssueProjectItems: RoadmapNonIssueProjectItem[] = [];
  for (const [index, value] of itemRecords.entries()) {
    const parsed = projectItemFromGraphQl(value, `Roadmap project.items.nodes[${index}]`);
    if (parsed.contentKind !== "ISSUE" || parsed.contentId === null) {
      nonIssueProjectItems.push({ id: parsed.item.id, contentKind: parsed.contentKind });
      continue;
    }
    const existing = mutableItems.get(parsed.contentId) ?? [];
    existing.push(parsed.item);
    mutableItems.set(parsed.contentId, existing);
  }
  return {
    id: projectId,
    statusOptions,
    priorityOptions,
    readinessOptions,
    itemsByContentId: new Map([...mutableItems].map(([key, value]) => [key, value] as const)),
    nonIssueProjectItems,
  };
}

type OpenIssueRelations = Pick<
  RoadmapGovernanceIssue,
  "parent" | "subIssues" | "blockedBy" | "closingPullRequests"
>;

async function runGhRest(path: string): Promise<unknown> {
  const { stdout } = await execFileAsync("gh", ["api", "--method", "GET", path], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(stdout) as unknown;
}

function closingPullRequests(value: unknown, subject: string) {
  return completeConnectionNodes(value, subject).map((pullRequest, index) => {
    const pullRequestSubject = `${subject}.nodes[${index}]`;
    const record = asRecord(pullRequest, pullRequestSubject);
    const repository = asRecord(record.repository, `${pullRequestSubject}.repository`);
    const rawState = stringValue(record.state, `${pullRequestSubject}.state`);
    if (rawState !== "OPEN" && rawState !== "CLOSED" && rawState !== "MERGED") {
      throw new Error(`${pullRequestSubject}.state is invalid`);
    }
    const state: RoadmapPullRequestState = rawState;
    return {
      repository: stringValue(
        repository.nameWithOwner,
        `${pullRequestSubject}.repository.nameWithOwner`,
      ),
      number: positiveInteger(record.number, `${pullRequestSubject}.number`),
      state,
      isDraft: booleanValue(record.isDraft, `${pullRequestSubject}.isDraft`),
      updatedAt: stringValue(record.updatedAt, `${pullRequestSubject}.updatedAt`),
    };
  });
}

async function loadOpenIssueRelations(repository: string): Promise<{
  readonly relations: ReadonlyMap<number, OpenIssueRelations>;
  readonly totalIssueCount: number;
}> {
  const { owner, name } = parseRepository(repository);
  const query = `query($after:String) {
    repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}) {
      allIssues: issues(states:[OPEN,CLOSED],first:1) { totalCount }
      issues(states:OPEN,first:25,after:$after,orderBy:{field:CREATED_AT,direction:ASC}) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          parent { number state repository { nameWithOwner } }
          subIssues(first:100) { totalCount nodes { number state repository { nameWithOwner } } }
          blockedBy(first:100) { totalCount nodes { number state repository { nameWithOwner } } }
          closedByPullRequestsReferences(first:100) {
            totalCount
            nodes { number state isDraft updatedAt repository { nameWithOwner } }
          }
        }
      }
    }
  }`;
  let after: string | null = null;
  let expected: number | null = null;
  let totalIssueCount: number | null = null;
  const result = new Map<number, OpenIssueRelations>();
  do {
    const args = ["-f", `query=${query}`];
    if (after !== null) {
      args.push("-f", `after=${after}`);
    }
    const payload = asRecord(await runGh(args), `${repository} relationship response`);
    const data = asRecord(payload.data, `${repository} relationship response.data`);
    const repositoryRecord = asRecord(data.repository, `${repository} relationship repository`);
    const allIssues = asRecord(repositoryRecord.allIssues, `${repository} all issues`);
    totalIssueCount ??= nonNegativeInteger(
      allIssues.totalCount,
      `${repository} all issues.totalCount`,
    );
    const connection = asRecord(repositoryRecord.issues, `${repository} relationship issues`);
    expected ??= nonNegativeInteger(connection.totalCount, `${repository} issues.totalCount`);
    const nodes = arrayValue(connection.nodes, `${repository} relationship issues.nodes`);
    for (const [index, value] of nodes.entries()) {
      const subject = `${repository} relationship issues.nodes[${index}]`;
      const record = asRecord(value, subject);
      const number = positiveInteger(record.number, `${subject}.number`);
      if (result.has(number)) {
        throw new Error(`${repository} relationship query returned duplicate issue #${number}`);
      }
      result.set(number, {
        parent:
          record.parent === null ? null : relationFromGraphQl(record.parent, `${subject}.parent`),
        subIssues: completeConnectionNodes(record.subIssues, `${subject}.subIssues`).map(
          (relation, relationIndex) =>
            relationFromGraphQl(relation, `${subject}.subIssues.nodes[${relationIndex}]`),
        ),
        blockedBy: completeConnectionNodes(record.blockedBy, `${subject}.blockedBy`).map(
          (relation, relationIndex) =>
            relationFromGraphQl(relation, `${subject}.blockedBy.nodes[${relationIndex}]`),
        ),
        closingPullRequests: closingPullRequests(
          record.closedByPullRequestsReferences,
          `${subject}.closedByPullRequestsReferences`,
        ),
      });
    }
    const pageInfo = asRecord(connection.pageInfo, `${repository} relationship issues.pageInfo`);
    after =
      pageInfo.hasNextPage === true
        ? stringValue(pageInfo.endCursor, `${repository} relationship issues.pageInfo.endCursor`)
        : null;
  } while (after !== null);
  if (expected === null || expected !== result.size || totalIssueCount === null) {
    throw new Error(
      `${repository} relationship pagination mismatch: expected ${expected ?? "unknown"}, received ${result.size}`,
    );
  }
  return { relations: result, totalIssueCount };
}

export function assertAllProjectIssueItemsConsumed(
  projectItems: ReadonlyMap<string, readonly RoadmapProjectItem[]>,
  consumedProjectContentIds: ReadonlySet<string>,
): void {
  const unconsumedProjectIssues = [...projectItems.keys()]
    .filter((contentId) => !consumedProjectContentIds.has(contentId))
    .sort();
  if (unconsumedProjectIssues.length > 0) {
    throw new Error(
      `Roadmap contains ${unconsumedProjectIssues.length} issue item(s) outside the canonical repository audit`,
    );
  }
}

async function loadRepositoryIssues(
  repository: string,
  projectItems: ReadonlyMap<string, readonly RoadmapProjectItem[]>,
  consumedProjectContentIds: Set<string>,
): Promise<readonly RoadmapGovernanceIssue[]> {
  const { relations, totalIssueCount } = await loadOpenIssueRelations(repository);
  const records: JsonRecord[] = [];
  for (let page = 1; ; page += 1) {
    const value = await runGhRest(
      `repos/${repository}/issues?state=all&sort=created&direction=asc&per_page=100&page=${page}`,
    );
    const pageRecords = arrayValue(value, `${repository} REST issues page ${page}`).map(
      (entry, index) => asRecord(entry, `${repository} REST issues page ${page}[${index}]`),
    );
    records.push(...pageRecords.filter((record) => record.pull_request === undefined));
    if (pageRecords.length < 100) {
      break;
    }
  }
  const issues = records.map((record, index): RoadmapGovernanceIssue => {
    const subject = `${repository} REST issues[${index}]`;
    const number = positiveInteger(record.number, `${subject}.number`);
    const rawState = stringValue(record.state, `${subject}.state`).toUpperCase();
    if (rawState !== "OPEN" && rawState !== "CLOSED") {
      throw new Error(`${subject}.state must be open or closed`);
    }
    const relation = rawState === "OPEN" ? relations.get(number) : undefined;
    if (rawState === "OPEN" && relation === undefined) {
      throw new Error(`${repository}#${number} is missing open relationship data`);
    }
    const assignees = arrayValue(record.assignees, `${subject}.assignees`).map(
      (assignee, assigneeIndex) =>
        stringValue(
          asRecord(assignee, `${subject}.assignees[${assigneeIndex}]`).login,
          `${subject}.assignees[${assigneeIndex}].login`,
        ),
    );
    const labels = arrayValue(record.labels, `${subject}.labels`).map((label, labelIndex) =>
      stringValue(
        asRecord(label, `${subject}.labels[${labelIndex}]`).name,
        `${subject}.labels[${labelIndex}].name`,
      ),
    );
    const milestoneRecord =
      record.milestone === null ? null : asRecord(record.milestone, `${subject}.milestone`);
    const milestone =
      milestoneRecord === null
        ? null
        : stringValue(milestoneRecord.title, `${subject}.milestone.title`);
    const rawMilestoneState =
      milestoneRecord === null
        ? null
        : stringValue(milestoneRecord.state, `${subject}.milestone.state`).toUpperCase();
    if (
      rawMilestoneState !== null &&
      rawMilestoneState !== "OPEN" &&
      rawMilestoneState !== "CLOSED"
    ) {
      throw new Error(`${subject}.milestone.state must be open or closed`);
    }
    const nodeId = stringValue(record.node_id, `${subject}.node_id`);
    if (projectItems.has(nodeId)) {
      consumedProjectContentIds.add(nodeId);
    }
    return {
      repository,
      number,
      title: stringValue(record.title, `${subject}.title`),
      body: typeof record.body === "string" ? record.body : "",
      state: rawState,
      createdAt: stringValue(record.created_at, `${subject}.created_at`),
      updatedAt: stringValue(record.updated_at, `${subject}.updated_at`),
      closedAt: nullableString(record.closed_at, `${subject}.closed_at`),
      assignees,
      labels,
      milestone,
      milestoneState: rawMilestoneState,
      parent: relation?.parent ?? null,
      subIssues: relation?.subIssues ?? [],
      blockedBy: relation?.blockedBy ?? [],
      closingPullRequests: relation?.closingPullRequests ?? [],
      projectItems: projectItems.get(nodeId) ?? [],
    };
  });
  if (issues.length !== totalIssueCount) {
    throw new Error(
      `${repository} issue mismatch: REST returned ${issues.length}, GraphQL expected ${totalIssueCount}`,
    );
  }
  const openRestCount = issues.filter((issue) => issue.state === "OPEN").length;
  if (openRestCount !== relations.size) {
    throw new Error(
      `${repository} open issue mismatch: REST returned ${openRestCount}, GraphQL returned ${relations.size}`,
    );
  }
  return issues;
}

async function loadLiveSnapshot(options: CliOptions): Promise<RoadmapGovernanceSnapshot> {
  if (options.source.kind !== "live") {
    throw new Error("live source required");
  }
  const project = await loadProject(options.projectOwner, options.projectNumber);
  const consumedProjectContentIds = new Set<string>();
  const issueGroups = await Promise.all(
    options.source.repositories.map((repository) =>
      loadRepositoryIssues(repository, project.itemsByContentId, consumedProjectContentIds),
    ),
  );
  assertAllProjectIssueItemsConsumed(project.itemsByContentId, consumedProjectContentIds);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    projectOwner: options.projectOwner,
    projectNumber: options.projectNumber,
    projectId: project.id,
    repositories: options.source.repositories,
    repositoryIssueCounts: options.source.repositories.map((repository, index) => ({
      repository,
      count: issueGroups[index]?.length ?? 0,
    })),
    statusOptions: project.statusOptions,
    priorityOptions: project.priorityOptions,
    readinessOptions: project.readinessOptions,
    issues: issueGroups.flat(),
    nonIssueProjectItems: project.nonIssueProjectItems,
  };
}

export function parseCli(argv: readonly string[]): CliOptions {
  const repositories: string[] = [];
  let snapshotPath: string | null = null;
  let projectOwner = "tyldra-org";
  let projectNumber = 1;
  let snapshotOut: string | null = null;
  let json = false;
  let livenessGraceHours = 7 * 24;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`${argument} requires a value`);
      }
      index += 1;
      return value;
    };
    switch (argument) {
      case "--live":
        repositories.push(next());
        break;
      case "--snapshot":
        snapshotPath = next();
        break;
      case "--project-owner":
        projectOwner = next();
        break;
      case "--project-number":
        projectNumber = Number(next());
        if (!Number.isSafeInteger(projectNumber) || projectNumber < 1) {
          throw new Error("--project-number must be a positive integer");
        }
        break;
      case "--snapshot-out":
        snapshotOut = next();
        break;
      case "--liveness-grace-hours":
        livenessGraceHours = Number(next());
        if (!Number.isFinite(livenessGraceHours) || livenessGraceHours < 0) {
          throw new Error("--liveness-grace-hours must be a non-negative number");
        }
        break;
      case "--json":
        json = true;
        break;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }
  if ((repositories.length === 0) === (snapshotPath === null)) {
    throw new Error("choose one or more --live owner/repository values or one --snapshot path");
  }
  const liveRepositories = [...new Set(repositories)].sort();
  if (snapshotPath === null && liveRepositories.join("\0") !== ROADMAP_REPOSITORIES.join("\0")) {
    throw new Error(`live audit requires exactly ${ROADMAP_REPOSITORIES.join(", ")}`);
  }
  if (projectOwner !== "tyldra-org" || projectNumber !== 1) {
    throw new Error("Roadmap audit requires tyldra-org Project 1");
  }
  return {
    source:
      snapshotPath === null
        ? { kind: "live", repositories: liveRepositories }
        : { kind: "snapshot", path: snapshotPath },
    projectOwner,
    projectNumber,
    snapshotOut,
    json,
    livenessGraceHours,
  };
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  const snapshot =
    options.source.kind === "live"
      ? parseRoadmapGovernanceSnapshot(await loadLiveSnapshot(options))
      : parseRoadmapGovernanceSnapshot(JSON.parse(await readFile(options.source.path, "utf8")));
  if (options.snapshotOut !== null) {
    await writeFile(options.snapshotOut, `${JSON.stringify(snapshot, null, 2)}\n`);
  }
  const report = analyzeRoadmapGovernance(snapshot, {
    livenessGraceHours: options.livenessGraceHours,
  });
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          project: `${snapshot.projectOwner}/${snapshot.projectNumber}`,
          repositories: snapshot.repositories,
          issueCount: snapshot.issues.length,
          nonIssueProjectItems: snapshot.nonIssueProjectItems.length,
          ...report,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(
      `Roadmap ${snapshot.projectOwner}/${snapshot.projectNumber}: ${snapshot.issues.length} issues, ${report.diagnostics.length} diagnostics\n`,
    );
    for (const diagnostic of report.diagnostics) {
      process.stdout.write(
        `${diagnostic.repository}#${diagnostic.issueNumber} [${diagnostic.code}] ${diagnostic.message}\n`,
      );
    }
    process.stdout.write(
      `\nDelivery sequence (${report.deliverySequence.length} actionable issues):\n`,
    );
    for (const entry of report.deliverySequence) {
      process.stdout.write(
        `${entry.position}. ${entry.repository}#${entry.issueNumber} [${entry.milestone}; ${entry.priority}; ${entry.readiness}] ${entry.title}\n`,
      );
    }
    process.stdout.write("\nIn Progress liveness:\n");
    for (const decision of report.liveness) {
      process.stdout.write(
        `${decision.repository}#${decision.issueNumber} [${decision.kind}] ${decision.detail}\n`,
      );
    }
  }
  if (report.diagnostics.length > 0) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
