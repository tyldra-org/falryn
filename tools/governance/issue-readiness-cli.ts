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
import { ROADMAP_PLANNING_FIELDS } from "./roadmap-governance/contracts.ts";

const execFileAsync = promisify(execFile);

type JsonRecord = Record<string, unknown>;

type CliOptions = {
  readonly source:
    | { readonly kind: "live"; readonly repository: string }
    | { readonly kind: "snapshot"; readonly path: string };
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

const ROADMAP_FIELD_NAMES = new Set<string>(Object.values(ROADMAP_PLANNING_FIELDS));

/** Whether an issue's field values include a Roadmap planning field. */
export function carriesRoadmapField(issueFieldValues: unknown, subject: string): boolean {
  return completeConnectionNodes(issueFieldValues, subject).some((value, index) => {
    const field = asRecord(
      asRecord(value, `${subject}.nodes[${index}]`).field,
      `${subject}.nodes[${index}].field`,
    );
    return ROADMAP_FIELD_NAMES.has(
      stringValue(field.name, `${subject}.nodes[${index}].field.name`),
    );
  });
}

export function liveIssueFromGraphQl(value: unknown): IssueReadinessIssue {
  const record = asRecord(value, "live issue");
  const parent =
    record.parent === null ? null : relationFromGraphQl(record.parent, "live issue.parent");
  const milestone =
    record.milestone === null ? null : asRecord(record.milestone, "live issue.milestone");
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
    targetRelease:
      milestone === null ? null : stringValue(milestone.title, "live issue.milestone.title"),
    roadmap: carriesRoadmapField(record.issueFieldValues, "live issue.issueFieldValues"),
    parent,
    subIssues: completeConnectionNodes(record.subIssues, "live issue.subIssues").map(
      (entry, index) => relationFromGraphQl(entry, `live issue.subIssues.nodes[${index}]`),
    ),
    blockedBy: completeConnectionNodes(record.blockedBy, "live issue.blockedBy").map(
      (entry, index) => relationFromGraphQl(entry, `live issue.blockedBy.nodes[${index}]`),
    ),
  };
}

async function loadLiveSnapshot(repository: string): Promise<IssueReadinessSnapshot> {
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
  const fieldName = "field{... on IssueFieldCommon{name}}";
  const query = `query($after:String){repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){issues(states:OPEN,first:100,after:$after,orderBy:{field:CREATED_AT,direction:ASC}){pageInfo{hasNextPage endCursor}nodes{number title body state updatedAt milestone{title} assignees(first:100){totalCount nodes{login}} labels(first:100){totalCount nodes{name}} parent{number state} subIssues(first:100){totalCount nodes{number state}} blockedBy(first:100){totalCount nodes{number state}} issueFieldValues(first:30){totalCount nodes{... on IssueFieldSingleSelectValue{${fieldName}} ... on IssueFieldTextValue{${fieldName}} ... on IssueFieldDateValue{${fieldName}} ... on IssueFieldNumberValue{${fieldName}} ... on IssueFieldMultiSelectValue{${fieldName}}}}}}}}`;
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

  const issues = issueRecords
    .map(liveIssueFromGraphQl)
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
  return { source, snapshotOut, baselinePath, docsRoot, json };
}

async function readSnapshot(path: string): Promise<IssueReadinessSnapshot> {
  return parseIssueReadinessSnapshot(JSON.parse(await readFile(path, "utf8")));
}

async function main(): Promise<void> {
  try {
    const options = parseCli(process.argv.slice(2));
    const snapshot =
      options.source.kind === "live"
        ? await loadLiveSnapshot(options.source.repository)
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
    const roadmapIssueCount = snapshot.issues.filter((issue) => issue.roadmap).length;
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
