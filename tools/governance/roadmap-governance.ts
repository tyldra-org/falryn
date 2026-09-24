import { Buffer } from "node:buffer";
import { declaresStandalone } from "./issue-governance-body";
import {
  CLOSED_PRIORITIES,
  type IssueKey,
  OPEN_PRIORITIES,
  READINESS_VALUES,
  ROADMAP_PLANNING_FIELDS,
  ROADMAP_PRIORITY_OPTIONS,
  ROADMAP_READINESS_OPTIONS,
  type RoadmapClosingPullRequest,
  type RoadmapDeliverySequenceEntry,
  type RoadmapFieldOption,
  type RoadmapGovernanceCode,
  type RoadmapGovernanceDiagnostic,
  type RoadmapGovernanceIssue,
  type RoadmapGovernanceReport,
  type RoadmapGovernanceSnapshot,
  type RoadmapIssueState,
  type RoadmapLivenessDecision,
  type RoadmapRelation,
  type RoadmapStatus,
} from "./roadmap-governance/contracts.ts";

export {
  ROADMAP_PLANNING_FIELDS,
  ROADMAP_PRIORITY_OPTIONS,
  ROADMAP_READINESS_OPTIONS,
  ROADMAP_REPOSITORIES,
  type RoadmapClosingPullRequest,
  type RoadmapDeliverySequenceEntry,
  type RoadmapFieldOption,
  type RoadmapGovernanceCode,
  type RoadmapGovernanceDiagnostic,
  type RoadmapGovernanceIssue,
  type RoadmapGovernanceReport,
  type RoadmapGovernanceSnapshot,
  type RoadmapIssueState,
  type RoadmapLivenessDecision,
  type RoadmapMilestone,
  type RoadmapPlanning,
  type RoadmapPlanningField,
  type RoadmapPriority,
  type RoadmapPullRequestState,
  type RoadmapReadiness,
  type RoadmapRelation,
  type RoadmapRepositoryIssueCount,
  type RoadmapRepositoryMilestones,
  type RoadmapStatus,
} from "./roadmap-governance/contracts.ts";
export { parseRoadmapGovernanceSnapshot } from "./roadmap-governance/parsing.ts";

export function issueKey(repository: string, number: number): IssueKey {
  return `${repository}#${number}`;
}

export function sameStrings(left: readonly string[], right: readonly string[]): boolean {
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

export function add(
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

type ReleaseCatalog = ReadonlyMap<
  string,
  { readonly rank: number; readonly state: RoadmapIssueState }
>;

function targetRelease(issue: RoadmapGovernanceIssue): string | null {
  return issue.planning?.release ?? null;
}

/**
 * The order a release milestone title encodes: `v<major>.<minor>` compared as a
 * decimal, so `v0.35` falls between `v0.3` and `v0.4`. Null when the title
 * does not start with a version.
 */
export function releaseOrderKey(title: string): number | null {
  const match = /^v(\d+)\.(\d+)(?:\s|$)/.exec(title);
  return match === null ? null : Number(`${match[1]}.${match[2]}`);
}

/**
 * Status is derived, never stored: a closed issue is Done; an open leaf is In
 * Progress while it has an open closing pull request; an open parent is In
 * Progress once any native child has started. Everything else is Todo.
 */
export function roadmapStatus(
  issue: RoadmapGovernanceIssue,
  issues: ReadonlyMap<IssueKey, RoadmapGovernanceIssue>,
): RoadmapStatus {
  if (issue.state === "CLOSED") {
    return "Done";
  }
  if (issue.subIssues.length === 0) {
    return openPullRequests(issue).length > 0 ? "In Progress" : "Todo";
  }
  return hasStartedChild(issue, issues, new Set()) ? "In Progress" : "Todo";
}

function hasStartedChild(
  issue: RoadmapGovernanceIssue,
  issues: ReadonlyMap<IssueKey, RoadmapGovernanceIssue>,
  visiting: Set<IssueKey>,
): boolean {
  const key = issueKey(issue.repository, issue.number);
  if (visiting.has(key)) {
    return false;
  }
  visiting.add(key);
  return issue.subIssues.some((relation) => {
    const child = issues.get(issueKey(relation.repository, relation.number));
    if (child === undefined) {
      return relation.state === "CLOSED";
    }
    return (
      child.state === "CLOSED" ||
      openPullRequests(child).length > 0 ||
      (child.subIssues.length > 0 && hasStartedChild(child, issues, visiting))
    );
  });
}

function releaseRank(name: string | null, releases: ReleaseCatalog): number {
  return name === null
    ? Number.MAX_SAFE_INTEGER
    : (releases.get(name)?.rank ?? Number.MAX_SAFE_INTEGER);
}

function declaresEarlyPrerequisiteRelease(
  issue: RoadmapGovernanceIssue,
  parent: RoadmapGovernanceIssue,
  releases: ReleaseCatalog,
): boolean {
  const childRelease = targetRelease(issue);
  const parentRelease = targetRelease(parent);
  const childRank = releaseRank(childRelease, releases);
  const parentRank = releaseRank(parentRelease, releases);
  if (
    childRelease === null ||
    parentRelease === null ||
    childRank === Number.MAX_SAFE_INTEGER ||
    parentRank === Number.MAX_SAFE_INTEGER ||
    childRank >= parentRank
  ) {
    return false;
  }
  const declaration = `early-prerequisite-v1; parent ${parent.repository}#${parent.number}; child ${childRelease}; parent ${parentRelease}.`;
  return issue.planning?.releaseException === declaration;
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

function sequence(
  issues: ReadonlyMap<IssueKey, RoadmapGovernanceIssue>,
  allIssues: ReadonlyMap<IssueKey, RoadmapGovernanceIssue>,
  releases: ReleaseCatalog,
): readonly RoadmapDeliverySequenceEntry[] {
  const edges = new Map<IssueKey, Set<IssueKey>>();
  const indegree = new Map<IssueKey, number>();
  const crossReleasePrerequisites = new Set<IssueKey>();
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
        targetRelease(blockerIssue) !== null &&
        targetRelease(issue) !== null &&
        releaseRank(targetRelease(blockerIssue), releases) >
          releaseRank(targetRelease(issue), releases)
      ) {
        crossReleasePrerequisites.add(blockerKey);
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
    issue.subIssues.length === 0 && roadmapStatus(issue, allIssues) === "In Progress";
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
      Number(right.planning?.priority === "P0") - Number(left.planning?.priority === "P0");
    if (p0Difference !== 0) {
      return p0Difference;
    }
    const releaseDifference =
      releaseRank(targetRelease(left) ?? "", releases) -
      releaseRank(targetRelease(right) ?? "", releases);
    if (releaseDifference !== 0) {
      return releaseDifference;
    }
    const priorityDifference =
      priorityRank(left.planning?.priority ?? "") - priorityRank(right.planning?.priority ?? "");
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
    const item = issue?.planning;
    const release = item?.release;
    const status = issue === undefined ? null : roadmapStatus(issue, allIssues);
    if (
      issue === undefined ||
      item === undefined ||
      item === null ||
      issue.subIssues.length > 0 ||
      release === null ||
      release === undefined ||
      (releases.get(targetRelease(issue) ?? "")?.state ?? null) !== "OPEN" ||
      !isOneOf(item.priority, OPEN_PRIORITIES) ||
      (item.readiness !== "Ready" &&
        item.readiness !== "Needs Planning" &&
        item.readiness !== "Needs Decision") ||
      (status !== "Todo" && status !== "In Progress")
    ) {
      continue;
    }
    result.push({
      position: result.length + 1,
      repository: issue.repository,
      issueNumber: issue.number,
      title: issue.title,
      targetRelease: release,
      priority: item.priority,
      readiness: item.readiness,
      status,
      openTransitiveDependents: dependentCounts.get(key) ?? 0,
      crossReleasePrerequisite: crossReleasePrerequisites.has(key),
    });
  }
  return result;
}

/**
 * The release catalog: every milestone title in the Roadmap repositories, which
 * must exist in each repository with the same state and a distinct version
 * order. Invalid entries become diagnostics and stay out of the catalog.
 */
function releaseCatalog(
  snapshot: RoadmapGovernanceSnapshot,
  diagnostics: RoadmapGovernanceDiagnostic[],
): ReleaseCatalog {
  const problems: string[] = [];
  for (const entry of snapshot.milestones) {
    const seen = new Set<string>();
    for (const milestone of entry.milestones) {
      if (seen.has(milestone.title)) {
        problems.push(`${entry.repository} has duplicate milestones titled ${milestone.title}`);
      }
      seen.add(milestone.title);
    }
  }
  const titles = [
    ...new Set(snapshot.milestones.flatMap((entry) => entry.milestones.map((m) => m.title))),
  ];
  const releases: { title: string; key: number; state: RoadmapIssueState }[] = [];
  for (const title of titles) {
    const key = releaseOrderKey(title);
    if (key === null) {
      problems.push(`milestone ${title} must start with v<major>.<minor>`);
      continue;
    }
    const states = snapshot.milestones.map(
      (entry) => entry.milestones.find((milestone) => milestone.title === title)?.state ?? null,
    );
    const missing = snapshot.milestones
      .filter((_, index) => states[index] === null)
      .map((entry) => entry.repository);
    if (missing.length > 0) {
      problems.push(`release ${title} is missing from ${missing.join(", ")}`);
      continue;
    }
    const [state] = states;
    if (state === null || state === undefined || states.some((entry) => entry !== state)) {
      problems.push(`release ${title} must have the same open or closed state in every repository`);
      continue;
    }
    releases.push({ title, key, state });
  }
  releases.sort((left, right) => left.key - right.key || compareText(left.title, right.title));
  for (let index = 1; index < releases.length; index += 1) {
    const previous = releases[index - 1];
    const current = releases[index];
    if (previous !== undefined && current !== undefined && previous.key === current.key) {
      problems.push(`releases ${previous.title} and ${current.title} share one version order`);
    }
  }
  if (releases.length === 0) {
    problems.push("no release milestones exist");
  }
  for (const message of problems) {
    diagnostics.push({ code: "release-catalog-invalid", repository: "*", issueNumber: 0, message });
  }
  return new Map(releases.map((release, rank) => [release.title, { rank, state: release.state }]));
}

/** The organization-only planning fields must match the contract exactly. */
function validatePlanningFields(
  snapshot: RoadmapGovernanceSnapshot,
  diagnostics: RoadmapGovernanceDiagnostic[],
): void {
  const expected = [
    {
      name: ROADMAP_PLANNING_FIELDS.priority,
      dataType: "SINGLE_SELECT",
      options: ROADMAP_PRIORITY_OPTIONS,
    },
    {
      name: ROADMAP_PLANNING_FIELDS.readiness,
      dataType: "SINGLE_SELECT",
      options: ROADMAP_READINESS_OPTIONS,
    },
    { name: ROADMAP_PLANNING_FIELDS.releaseException, dataType: "TEXT", options: [] },
  ] as const;
  for (const expectation of expected) {
    const matches = snapshot.planningFields.filter((field) => field.name === expectation.name);
    const field = matches[0];
    const problem =
      matches.length !== 1 || field === undefined
        ? "must exist exactly once"
        : field.visibility !== "ORG_ONLY"
          ? "must be organization-only"
          : field.dataType !== expectation.dataType
            ? `must be ${expectation.dataType}`
            : !sameFieldOptions(field.options, expectation.options)
              ? "options must match the contract names, descriptions, colors, and order"
              : null;
    if (problem !== null) {
      diagnostics.push({
        code: "planning-field-invalid",
        repository: "*",
        issueNumber: 0,
        message: `${expectation.name} ${problem}`,
      });
    }
  }
}

export function analyzeRoadmapGovernance(
  snapshot: RoadmapGovernanceSnapshot,
): RoadmapGovernanceReport {
  const diagnostics: RoadmapGovernanceDiagnostic[] = [];
  const liveness: RoadmapLivenessDecision[] = [];
  const releases = releaseCatalog(snapshot, diagnostics);
  validatePlanningFields(snapshot, diagnostics);

  const allIssues = new Map<IssueKey, RoadmapGovernanceIssue>(
    snapshot.issues.map((issue) => [issueKey(issue.repository, issue.number), issue]),
  );
  const managedIssues = new Map<IssueKey, RoadmapGovernanceIssue>(
    [...allIssues].filter(([, issue]) => issue.planning !== null),
  );
  const issues = new Map<IssueKey, RoadmapGovernanceIssue>(
    [...managedIssues].filter(([, issue]) => issue.state === "OPEN"),
  );

  for (const issue of [...snapshot.issues].sort((left, right) => {
    const repositoryDifference = compareText(left.repository, right.repository);
    return repositoryDifference !== 0 ? repositoryDifference : left.number - right.number;
  })) {
    const item = issue.planning;
    if (item === null) {
      continue;
    }
    const status = roadmapStatus(issue, allIssues);

    if (issue.state === "OPEN" && item.releaseException !== null) {
      const parent =
        issue.parent === null
          ? undefined
          : allIssues.get(issueKey(issue.parent.repository, issue.parent.number));
      if (parent === undefined || !declaresEarlyPrerequisiteRelease(issue, parent, releases)) {
        add(
          diagnostics,
          "release-exception-invalid",
          issue,
          "private release exception no longer matches the parent and selected releases",
        );
      }
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
      if (targetRelease(issue) === null) {
        add(diagnostics, "target-release-missing", issue, "missing release");
      } else if ((releases.get(targetRelease(issue) ?? "")?.state ?? null) === "CLOSED") {
        add(
          diagnostics,
          "target-release-closed",
          issue,
          `open issue belongs to closed release ${targetRelease(issue)}`,
        );
      } else if (releaseRank(targetRelease(issue), releases) === Number.MAX_SAFE_INTEGER) {
        add(
          diagnostics,
          "target-release-order-unknown",
          issue,
          `unknown release order: ${targetRelease(issue)}`,
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
          targetRelease(issue) !== null &&
          (releases.get(targetRelease(issue) ?? "")?.state ?? null) === "OPEN" &&
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
      if (issue.subIssues.length === 0 && status === "In Progress" && item.readiness !== "Ready") {
        add(
          diagnostics,
          "in-progress-readiness-invalid",
          issue,
          `leaf with an open closing pull request must be Ready; found ${item.readiness ?? "none"}`,
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
      }

      if (status === "In Progress") {
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
          liveness.push({
            repository: issue.repository,
            issueNumber: issue.number,
            kind: "open-pull-request",
            detail: "open closing pull request proves active delivery",
          });
        }
      }
      if (
        issue.subIssues.length === 0 &&
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

  for (const issue of managedIssues.values()) {
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
      if (target.planning === null && (kind !== "blocker" || relation.state === "OPEN")) {
        add(
          diagnostics,
          "relationship-target-missing",
          issue,
          `${kind} ${targetKey} is outside the Roadmap`,
        );
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
      if (
        target !== undefined &&
        (targetRelease(issue) === null || targetRelease(target) === null)
      ) {
        add(
          diagnostics,
          "hierarchy-target-release-missing",
          target,
          `native child or parent release is missing for ${sourceKey}`,
        );
      } else if (
        target !== undefined &&
        targetRelease(issue) !== null &&
        targetRelease(target) !== null &&
        targetRelease(target) !== targetRelease(issue) &&
        !declaresEarlyPrerequisiteRelease(target, issue, releases)
      ) {
        add(
          diagnostics,
          "hierarchy-target-release-mismatch",
          target,
          `release ${targetRelease(target)} differs from parent release ${targetRelease(issue)}`,
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
    deliverySequence: diagnostics.length === 0 ? sequence(issues, allIssues, releases) : [],
    liveness: liveness.sort((left, right) => {
      const repositoryDifference = compareText(left.repository, right.repository);
      return repositoryDifference !== 0
        ? repositoryDifference
        : left.issueNumber - right.issueNumber;
    }),
  };
}
