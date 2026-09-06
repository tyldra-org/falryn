import { execFile } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";

import {
  auditIssueReadiness,
  ISSUE_READINESS_SCHEMA_VERSION,
  type IssueReadinessIssue,
  type IssueReadinessRelation,
  type IssueReadinessSnapshot,
  type IssueState,
  parseIssueReadinessSnapshot,
} from "./issue-readiness.ts";

const execFileAsync = promisify(execFile);

type JsonRecord = Record<string, unknown>;

type CliOptions = {
  readonly source:
    | { readonly kind: "live"; readonly repository: string }
    | { readonly kind: "snapshot"; readonly path: string };
  readonly projectOwner: string;
  readonly projectNumber: number;
  readonly snapshotOut: string | null;
  readonly baselinePath: string | null;
  readonly docsRoot: string | null;
  readonly json: boolean;
};

function asRecord(value: unknown, subject: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${subject} must be an object`);
  }
  return value as JsonRecord;
}

function stringValue(value: unknown, subject: string): string {
  if (typeof value !== "string") {
    throw new Error(`${subject} must be a string`);
  }
  return value;
}

function positiveInteger(value: unknown, subject: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${subject} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, subject: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${subject} must be a non-negative integer`);
  }
  return value;
}

function arrayValue(value: unknown, subject: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${subject} must be an array`);
  }
  return value;
}

function issueState(value: unknown, subject: string): IssueState {
  if (value !== "OPEN" && value !== "CLOSED") {
    throw new Error(`${subject} must be OPEN or CLOSED`);
  }
  return value;
}

function completeConnectionNodes(value: unknown, subject: string): readonly unknown[] {
  const connection = asRecord(value, subject);
  const nodes = arrayValue(connection.nodes, `${subject}.nodes`);
  const totalCount = nonNegativeInteger(connection.totalCount, `${subject}.totalCount`);
  if (nodes.length !== totalCount) {
    throw new Error(`${subject} is truncated: received ${nodes.length} of ${totalCount}`);
  }
  return nodes;
}

async function documentationPathSet(root: string): Promise<ReadonlySet<string>> {
  const absoluteRoot = resolve(root);
  const paths = new Set<string>();

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        paths.add(relative(absoluteRoot, path).replaceAll("\\", "/"));
      }
    }
  }

  await walk(absoluteRoot);
  return paths;
}

async function runGh(args: readonly string[]): Promise<unknown> {
  const result = await execFileAsync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(result.stdout);
}

function relationFromGraphQl(value: unknown, subject: string): IssueReadinessRelation {
  const record = asRecord(value, subject);
  return {
    number: positiveInteger(record.number, `${subject}.number`),
    state: issueState(record.state, `${subject}.state`),
  };
}

function liveIssueFromGraphQl(
  value: unknown,
  roadmapItemCount: number,
  roadmapStatuses: readonly string[],
): IssueReadinessIssue {
  const record = asRecord(value, "live issue");
  const milestone =
    record.milestone === null ? null : asRecord(record.milestone, "live issue.milestone");
  const parent =
    record.parent === null ? null : relationFromGraphQl(record.parent, "live issue.parent");
  return {
    number: positiveInteger(record.number, "live issue.number"),
    title: stringValue(record.title, "live issue.title"),
    body: stringValue(record.body, "live issue.body"),
    state: issueState(record.state, "live issue.state"),
    updatedAt: stringValue(record.updatedAt, "live issue.updatedAt"),
    assignees: completeConnectionNodes(record.assignees, "live issue.assignees").map((entry) =>
      stringValue(asRecord(entry, "assignee").login, "assignee.login"),
    ),
    labels: completeConnectionNodes(record.labels, "live issue.labels").map((entry) =>
      stringValue(asRecord(entry, "label").name, "label.name"),
    ),
    milestone: milestone === null ? null : stringValue(milestone.title, "milestone.title"),
    roadmapItemCount,
    roadmapStatuses,
    parent,
    subIssues: completeConnectionNodes(record.subIssues, "live issue.subIssues").map(
      (entry, index) => relationFromGraphQl(entry, `live issue.subIssues.nodes[${index}]`),
    ),
    blockedBy: completeConnectionNodes(record.blockedBy, "live issue.blockedBy").map(
      (entry, index) => relationFromGraphQl(entry, `live issue.blockedBy.nodes[${index}]`),
    ),
  };
}

async function loadRoadmapStatuses(
  repository: string,
  projectOwner: string,
  projectNumber: number,
): Promise<
  ReadonlyMap<number, { readonly itemCount: number; readonly statuses: readonly string[] }>
> {
  const query = `query($after:String) {
  repositoryOwner(login:${JSON.stringify(projectOwner)}) {
    ... on Organization { projectV2(number:${projectNumber}) { ...ProjectItems } }
    ... on User { projectV2(number:${projectNumber}) { ...ProjectItems } }
  }
}
fragment ProjectItems on ProjectV2 {
  items(first:100,after:$after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      content { ... on Issue { number repository { nameWithOwner } } }
      fieldValues(first:100) {
        totalCount
        nodes {
          ... on ProjectV2ItemFieldSingleSelectValue {
            name
            field { ... on ProjectV2SingleSelectField { name } }
          }
        }
      }
    }
  }
}`;
  const membership = new Map<number, { itemCount: number; statuses: string[] }>();
  let after: string | null = null;
  while (true) {
    const args = ["api", "graphql", "-f", `query=${query}`];
    if (after !== null) {
      args.push("-F", `after=${after}`);
    }
    const data = asRecord(await runGh(args), "Roadmap GraphQL response");
    const root = asRecord(data.data, "Roadmap GraphQL response.data");
    const repositoryOwner = asRecord(root.repositoryOwner, "Roadmap owner");
    const project = asRecord(repositoryOwner.projectV2, "Roadmap project");
    const items = asRecord(project.items, "Roadmap project.items");
    for (const value of arrayValue(items.nodes, "Roadmap project.items.nodes")) {
      const item = asRecord(value, "Roadmap item");
      if (item.content === null || typeof item.content !== "object") {
        continue;
      }
      const content = asRecord(item.content, "Roadmap item.content");
      if (typeof content.number !== "number" || typeof content.repository !== "object") {
        continue;
      }
      const contentRepository = asRecord(content.repository, "Roadmap item.repository");
      if (contentRepository.nameWithOwner !== repository) {
        continue;
      }
      const number = positiveInteger(content.number, "Roadmap item.number");
      const current = membership.get(number) ?? { itemCount: 0, statuses: [] };
      const issueStatuses = [...current.statuses];
      for (const fieldValue of completeConnectionNodes(
        item.fieldValues,
        "Roadmap item.fieldValues",
      )) {
        const fieldRecord = asRecord(fieldValue, "Roadmap field value");
        if (typeof fieldRecord.name !== "string" || typeof fieldRecord.field !== "object") {
          continue;
        }
        const field = asRecord(fieldRecord.field, "Roadmap field value.field");
        if (field.name === "Status") {
          issueStatuses.push(fieldRecord.name);
        }
      }
      membership.set(number, { itemCount: current.itemCount + 1, statuses: issueStatuses });
    }
    const pageInfo = asRecord(items.pageInfo, "Roadmap project.items.pageInfo");
    if (pageInfo.hasNextPage !== true) {
      return membership;
    }
    after = stringValue(pageInfo.endCursor, "Roadmap project.items.pageInfo.endCursor");
  }
}

async function loadLiveSnapshot(
  repository: string,
  projectOwner: string,
  projectNumber: number,
): Promise<IssueReadinessSnapshot> {
  const [owner, name, extra] = repository.split("/");
  if (
    owner === undefined ||
    name === undefined ||
    extra !== undefined ||
    owner === "" ||
    name === ""
  ) {
    throw new Error("--live must use owner/repository");
  }
  const query = `query($after:String){repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){issues(states:OPEN,first:100,after:$after,orderBy:{field:CREATED_AT,direction:ASC}){pageInfo{hasNextPage endCursor}nodes{number title body state updatedAt assignees(first:100){totalCount nodes{login}} labels(first:100){totalCount nodes{name}} milestone{title} parent{number state} subIssues(first:100){totalCount nodes{number state}} blockedBy(first:100){totalCount nodes{number state}}}}}}`;
  const issueRecords: unknown[] = [];
  let after: string | null = null;
  while (true) {
    const args = ["api", "graphql", "-f", `query=${query}`];
    if (after !== null) {
      args.push("-F", `after=${after}`);
    }
    const data = asRecord(await runGh(args), "GraphQL response");
    const root = asRecord(data.data, "GraphQL response.data");
    const repositoryRecord = asRecord(root.repository, "GraphQL response.data.repository");
    const issues = asRecord(repositoryRecord.issues, "GraphQL response.data.repository.issues");
    issueRecords.push(...arrayValue(issues.nodes, "GraphQL issues.nodes"));
    const pageInfo = asRecord(issues.pageInfo, "GraphQL issues.pageInfo");
    if (pageInfo.hasNextPage !== true) {
      break;
    }
    after = stringValue(pageInfo.endCursor, "GraphQL issues.pageInfo.endCursor");
  }

  const membership = await loadRoadmapStatuses(repository, projectOwner, projectNumber);
  const issues = issueRecords
    .map((value) => {
      const record = asRecord(value, "live issue");
      const number = positiveInteger(record.number, "live issue.number");
      const roadmap = membership.get(number) ?? { itemCount: 0, statuses: [] };
      return liveIssueFromGraphQl(value, roadmap.itemCount, roadmap.statuses);
    })
    .sort((left, right) => left.number - right.number);
  return {
    schemaVersion: ISSUE_READINESS_SCHEMA_VERSION,
    repository,
    generatedAt: new Date().toISOString(),
    issues,
  };
}

function parseCli(argv: readonly string[]): CliOptions {
  let source: CliOptions["source"] | null = null;
  let projectOwner = "tyldra-org";
  let projectNumber = 1;
  let snapshotOut: string | null = null;
  let baselinePath: string | null = null;
  let docsRoot: string | null = null;
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
        if (source !== null) {
          throw new Error("choose exactly one of --live or --snapshot");
        }
        source = { kind: "live", repository: next() };
        break;
      case "--snapshot":
        if (source !== null) {
          throw new Error("choose exactly one of --live or --snapshot");
        }
        source = { kind: "snapshot", path: next() };
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
      case "--baseline":
        baselinePath = next();
        break;
      case "--docs-root":
        docsRoot = next();
        break;
      case "--json":
        json = true;
        break;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (source === null) {
    throw new Error("choose --live owner/repository or --snapshot path");
  }
  return { source, projectOwner, projectNumber, snapshotOut, baselinePath, docsRoot, json };
}

async function readSnapshot(path: string): Promise<IssueReadinessSnapshot> {
  return parseIssueReadinessSnapshot(JSON.parse(await readFile(path, "utf8")));
}

async function main(): Promise<void> {
  try {
    const options = parseCli(process.argv.slice(2));
    const snapshot =
      options.source.kind === "live"
        ? await loadLiveSnapshot(
            options.source.repository,
            options.projectOwner,
            options.projectNumber,
          )
        : await readSnapshot(options.source.path);
    if (options.snapshotOut !== null) {
      await writeFile(options.snapshotOut, `${JSON.stringify(snapshot, null, 2)}\n`);
    }
    const baseline =
      options.baselinePath === null ? undefined : await readSnapshot(options.baselinePath);
    if (baseline !== undefined && baseline.repository !== snapshot.repository) {
      throw new Error(
        `baseline repository ${baseline.repository} does not match ${snapshot.repository}`,
      );
    }
    const documentationPaths =
      options.docsRoot === null ? undefined : await documentationPathSet(options.docsRoot);
    const diagnostics = auditIssueReadiness(snapshot, {
      ...(baseline === undefined ? {} : { baseline }),
      ...(documentationPaths === undefined ? {} : { documentationPaths }),
    });
    const roadmapIssueCount = snapshot.issues.filter((issue) => issue.roadmapItemCount > 0).length;
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            repository: snapshot.repository,
            issueCount: snapshot.issues.length,
            repositoryIssueCount: snapshot.issues.length,
            roadmapIssueCount,
            diagnostics,
          },
          null,
          2,
        ),
      );
    } else if (diagnostics.length === 0) {
      console.log(
        `issue readiness verified for ${roadmapIssueCount} Roadmap-owned open issues from ${snapshot.issues.length} open repository issues in ${snapshot.repository}`,
      );
    } else {
      for (const diagnostic of diagnostics) {
        console.error(
          `issue readiness: #${diagnostic.issueNumber} ${diagnostic.code} (${diagnostic.subject})`,
        );
      }
    }
    if (diagnostics.length > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`issue readiness audit failed: ${message}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
