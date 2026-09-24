import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  analyzeRoadmapGovernance,
  parseRoadmapGovernanceSnapshot,
  ROADMAP_PLANNING_FIELDS,
  ROADMAP_REPOSITORIES,
  type RoadmapFieldOption,
  type RoadmapGovernanceIssue,
  type RoadmapGovernanceSnapshot,
  type RoadmapPlanning,
  type RoadmapPlanningField,
  type RoadmapPullRequestState,
  type RoadmapRelation,
  type RoadmapRepositoryMilestones,
} from "./roadmap-governance";

const execFileAsync = promisify(execFile);

type JsonRecord = { readonly [key: string]: unknown };
type CliOptions = {
  readonly source:
    | { readonly kind: "live"; readonly repositories: readonly string[] }
    | { readonly kind: "snapshot"; readonly path: string };
  readonly snapshotOut: string | null;
  readonly json: boolean;
};

/** The organization that owns the Roadmap repositories and planning fields. */
const ROADMAP_OWNER = "tyldra-org";

export type OpenIssueRelations = Pick<
  RoadmapGovernanceIssue,
  "parent" | "subIssues" | "blockedBy" | "closingPullRequests"
>;

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

function fieldOptionFromGraphQl(value: unknown, subject: string): RoadmapFieldOption {
  const record = asRecord(value, subject);
  return {
    name: stringValue(record.name, `${subject}.name`),
    description: stringValue(record.description, `${subject}.description`),
    color: stringValue(record.color, `${subject}.color`),
  };
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

export async function loadOpenIssueRelations(
  repository: string,
  runQuery: (args: readonly string[]) => Promise<unknown> = runGh,
): Promise<{
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
          # GitHub excludes closed-unmerged PRs by default; liveness needs their state.
          closedByPullRequestsReferences(first:100,includeClosedPrs:true) {
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
    const payload = asRecord(await runQuery(args), `${repository} relationship response`);
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

/**
 * An issue's planning facts from its REST record: the milestone title and the
 * organization-only Roadmap fields. Null when the issue carries no Roadmap field.
 */
export function planningFromRest(record: JsonRecord, subject: string): RoadmapPlanning | null {
  const values = new Map<string, string>();
  const fieldValues = record.issue_field_values ?? [];
  for (const [index, value] of arrayValue(fieldValues, `${subject}.issue_field_values`).entries()) {
    const entry = asRecord(value, `${subject}.issue_field_values[${index}]`);
    const name = stringValue(
      entry.issue_field_name,
      `${subject}.issue_field_values[${index}].issue_field_name`,
    );
    const option = entry.single_select_option;
    const text =
      option === null || option === undefined
        ? entry.value
        : asRecord(option, `${subject}.issue_field_values[${index}].single_select_option`).name;
    values.set(name, stringValue(text, `${subject}.issue_field_values[${index}] ${name}`));
  }
  const priority = values.get(ROADMAP_PLANNING_FIELDS.priority) ?? null;
  const readiness = values.get(ROADMAP_PLANNING_FIELDS.readiness) ?? null;
  const releaseException = values.get(ROADMAP_PLANNING_FIELDS.releaseException) ?? null;
  if (priority === null && readiness === null && releaseException === null) {
    return null;
  }
  const milestone =
    record.milestone === null || record.milestone === undefined
      ? null
      : asRecord(record.milestone, `${subject}.milestone`);
  return {
    priority,
    readiness,
    release: milestone === null ? null : stringValue(milestone.title, `${subject}.milestone.title`),
    releaseException,
  };
}

/** The organization issue fields whose names the Roadmap owns, options in configured order. */
async function loadPlanningFields(owner: string): Promise<readonly RoadmapPlanningField[]> {
  const query = `query {
    organization(login:${JSON.stringify(owner)}) {
      issueFields(first:50) {
        totalCount
        nodes {
          ... on IssueFieldCommon { name dataType visibility }
          ... on IssueFieldSingleSelect { options { name description color priority } }
        }
      }
    }
  }`;
  const payload = asRecord(await runGh(["-f", `query=${query}`]), "planning field response");
  const organization = asRecord(
    asRecord(payload.data, "planning field response.data").organization,
    "organization",
  );
  const roadmapNames = new Set<string>(Object.values(ROADMAP_PLANNING_FIELDS));
  return completeConnectionNodes(organization.issueFields, "organization.issueFields")
    .map((value, index) => asRecord(value, `organization.issueFields.nodes[${index}]`))
    .filter((field) => roadmapNames.has(String(field.name)))
    .map((field, index): RoadmapPlanningField => {
      const subject = `planning field ${String(field.name)}`;
      const options = Array.isArray(field.options) ? field.options : [];
      return {
        name: stringValue(field.name, `${subject}.name`),
        dataType: stringValue(field.dataType, `${subject}.dataType`),
        visibility: stringValue(field.visibility, `${subject}.visibility`),
        options: options
          .map((option, optionIndex) => ({
            option: fieldOptionFromGraphQl(option, `${subject}.options[${optionIndex}]`),
            priority: Number(
              asRecord(option, `${subject}.options[${optionIndex}]`).priority ?? index,
            ),
          }))
          .sort((left, right) => left.priority - right.priority)
          .map((entry) => entry.option),
      };
    });
}

async function loadMilestones(repository: string): Promise<RoadmapRepositoryMilestones> {
  const milestones: { title: string; state: "OPEN" | "CLOSED" }[] = [];
  for (let page = 1; ; page += 1) {
    const value = await runGhRest(
      `repos/${repository}/milestones?state=all&sort=due_on&per_page=100&page=${page}`,
    );
    const records = arrayValue(value, `${repository} milestones page ${page}`);
    for (const [index, entry] of records.entries()) {
      const record = asRecord(entry, `${repository} milestones page ${page}[${index}]`);
      const state = stringValue(
        record.state,
        `${repository} milestone ${index}.state`,
      ).toUpperCase();
      if (state !== "OPEN" && state !== "CLOSED") {
        throw new Error(`${repository} milestone ${index}.state must be open or closed`);
      }
      milestones.push({
        title: stringValue(record.title, `${repository} milestone ${index}.title`),
        state,
      });
    }
    if (records.length < 100) {
      return { repository, milestones };
    }
  }
}

async function loadRepositoryIssues(
  repository: string,
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
      parent: relation?.parent ?? null,
      subIssues: relation?.subIssues ?? [],
      blockedBy: relation?.blockedBy ?? [],
      closingPullRequests: relation?.closingPullRequests ?? [],
      planning: planningFromRest(record, subject),
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

export async function loadLiveSnapshot(options: CliOptions): Promise<RoadmapGovernanceSnapshot> {
  if (options.source.kind !== "live") {
    throw new Error("live source required");
  }
  const repositories = options.source.repositories;
  const [planningFields, milestones, issueGroups] = await Promise.all([
    loadPlanningFields(ROADMAP_OWNER),
    Promise.all(repositories.map(loadMilestones)),
    Promise.all(repositories.map(loadRepositoryIssues)),
  ]);
  return {
    schemaVersion: 4,
    generatedAt: new Date().toISOString(),
    owner: ROADMAP_OWNER,
    repositories,
    repositoryIssueCounts: repositories.map((repository, index) => ({
      repository,
      count: issueGroups[index]?.length ?? 0,
    })),
    planningFields,
    milestones,
    issues: issueGroups.flat(),
  };
}

export function parseCli(argv: readonly string[]): CliOptions {
  const repositories: string[] = [];
  let snapshotPath: string | null = null;
  let snapshotOut: string | null = null;
  let json = false;
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
      case "--snapshot-out":
        snapshotOut = next();
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
  return {
    source:
      snapshotPath === null
        ? { kind: "live", repositories: liveRepositories }
        : { kind: "snapshot", path: snapshotPath },
    snapshotOut,
    json,
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
  const report = analyzeRoadmapGovernance(snapshot);
  const roadmapIssueCount = snapshot.issues.filter((issue) => issue.planning !== null).length;
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          owner: snapshot.owner,
          repositories: snapshot.repositories,
          issueCount: snapshot.issues.length,
          repositoryIssueCount: snapshot.issues.length,
          roadmapIssueCount,
          ...report,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(
      `Roadmap ${snapshot.owner}: ${roadmapIssueCount} managed issues from ${snapshot.issues.length} repository issues, ${report.diagnostics.length} diagnostics\n`,
    );
    for (const diagnostic of report.diagnostics) {
      process.stdout.write(
        `${diagnostic.repository}#${diagnostic.issueNumber} [${diagnostic.code}] ${diagnostic.message}\n`,
      );
    }
    process.stdout.write(
      `\nRouting sequence (${report.deliverySequence.length} open leaf issues):\n`,
    );
    for (const entry of report.deliverySequence) {
      process.stdout.write(
        `${entry.position}. ${entry.repository}#${entry.issueNumber} [${entry.targetRelease}; ${entry.priority}; ${entry.readiness}] ${entry.title}\n`,
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
