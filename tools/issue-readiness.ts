import { declaresStandalone } from "./issue-governance-body";

export const ISSUE_READINESS_SCHEMA_VERSION = 1 as const;
export const DEFAULT_MAXIMUM_ISSUE_BODY_BYTES = 65_536;

const ROADMAP_STATUSES = new Set(["Todo", "In Progress", "Done"]);
const REQUIRED_HEADINGS = ["Outcome", "Completion proof"] as const;
const SHARED_MARKER = "<!-- shared-delivery-governance-v1 -->";
const LEGACY_SHARED_MARKER = "<!-- whole-product-excellence-contract-2026-08-24 -->";
const AUDIT_MARKER = "<!-- all-open-audit-reconciliation-2026-09-01 -->";
const CANONICAL_DOC_LINK =
  /https:\/\/github\.com\/tyldra-org\/falryn-docs\/blob\/main\/([^\s)#?]+)(?:#[^\s)]*)?/g;
const OBSOLETE_CANONICAL_OWNER_LINK =
  /https:\/\/github\.com\/yogeshprasad098\/falryn-docs\/blob\/main\//i;
const ISSUE_REFERENCE = /#(\d+)\b/g;
const DECLARED_CHILD_COUNT = /\b(\d+)\s+native GitHub sub-?issues\b/gi;

export type IssueState = "OPEN" | "CLOSED";

export type IssueReadinessRelation = {
  readonly number: number;
  readonly state: IssueState;
};

export type IssueReadinessIssue = {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: IssueState;
  readonly updatedAt: string;
  readonly assignees: readonly string[];
  readonly labels: readonly string[];
  readonly milestone: string | null;
  readonly roadmapStatuses: readonly string[];
  readonly parent: IssueReadinessRelation | null;
  readonly subIssues: readonly IssueReadinessRelation[];
  readonly blockedBy: readonly IssueReadinessRelation[];
};

export type IssueReadinessSnapshot = {
  readonly schemaVersion: typeof ISSUE_READINESS_SCHEMA_VERSION;
  readonly repository: string;
  readonly generatedAt: string;
  readonly issues: readonly IssueReadinessIssue[];
};

export type IssueReadinessCode =
  | "assignee-count"
  | "work-type-count"
  | "area-missing"
  | "milestone-missing"
  | "roadmap-status-count"
  | "planning-relationship-missing"
  | "parent-reference-missing"
  | "hierarchy-reciprocity"
  | "body-empty"
  | "body-too-large"
  | "heading-missing"
  | "shared-appendix-duplicate"
  | "legacy-shared-appendix"
  | "audit-marker-duplicate"
  | "marker-unbalanced"
  | "stale-child-count"
  | "pr-sized-has-children"
  | "open-blocker-not-mentioned"
  | "prose-blocker-not-native-open"
  | "dependency-cycle"
  | "canonical-document-missing"
  | "canonical-document-owner-invalid"
  | "docs-only-product-completion"
  | "body-title-drift"
  | "body-milestone-drift";

export type IssueReadinessDiagnostic = {
  readonly code: IssueReadinessCode;
  readonly issueNumber: number;
  readonly subject: string;
};

export type IssueReadinessAuditOptions = {
  readonly maximumBodyBytes?: number;
  readonly documentationPaths?: ReadonlySet<string>;
  readonly baseline?: IssueReadinessSnapshot;
};

type JsonRecord = Record<string, unknown>;

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

function nullableString(value: unknown, subject: string): string | null {
  if (value === null) {
    return null;
  }
  return stringValue(value, subject);
}

function positiveInteger(value: unknown, subject: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${subject} must be a positive integer`);
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

function parseRelation(value: unknown, subject: string): IssueReadinessRelation {
  const record = asRecord(value, subject);
  return {
    number: positiveInteger(record.number, `${subject}.number`),
    state: issueState(record.state, `${subject}.state`),
  };
}

function parseIssue(value: unknown, index: number): IssueReadinessIssue {
  const subject = `issues[${index}]`;
  const record = asRecord(value, subject);
  const parent = record.parent === null ? null : parseRelation(record.parent, `${subject}.parent`);
  return {
    number: positiveInteger(record.number, `${subject}.number`),
    title: stringValue(record.title, `${subject}.title`),
    body: stringValue(record.body, `${subject}.body`),
    state: issueState(record.state, `${subject}.state`),
    updatedAt: stringValue(record.updatedAt, `${subject}.updatedAt`),
    assignees: arrayValue(record.assignees, `${subject}.assignees`).map((entry, itemIndex) =>
      stringValue(entry, `${subject}.assignees[${itemIndex}]`),
    ),
    labels: arrayValue(record.labels, `${subject}.labels`).map((entry, itemIndex) =>
      stringValue(entry, `${subject}.labels[${itemIndex}]`),
    ),
    milestone: nullableString(record.milestone, `${subject}.milestone`),
    roadmapStatuses: arrayValue(record.roadmapStatuses, `${subject}.roadmapStatuses`).map(
      (entry, itemIndex) => stringValue(entry, `${subject}.roadmapStatuses[${itemIndex}]`),
    ),
    parent,
    subIssues: arrayValue(record.subIssues, `${subject}.subIssues`).map((entry, itemIndex) =>
      parseRelation(entry, `${subject}.subIssues[${itemIndex}]`),
    ),
    blockedBy: arrayValue(record.blockedBy, `${subject}.blockedBy`).map((entry, itemIndex) =>
      parseRelation(entry, `${subject}.blockedBy[${itemIndex}]`),
    ),
  };
}

export function parseIssueReadinessSnapshot(value: unknown): IssueReadinessSnapshot {
  const record = asRecord(value, "snapshot");
  if (record.schemaVersion !== ISSUE_READINESS_SCHEMA_VERSION) {
    throw new Error(`snapshot.schemaVersion must be ${ISSUE_READINESS_SCHEMA_VERSION}`);
  }
  const issues = arrayValue(record.issues, "snapshot.issues").map(parseIssue);
  const seen = new Set<number>();
  for (const issue of issues) {
    if (seen.has(issue.number)) {
      throw new Error(`snapshot contains duplicate issue #${issue.number}`);
    }
    seen.add(issue.number);
  }
  return {
    schemaVersion: ISSUE_READINESS_SCHEMA_VERSION,
    repository: stringValue(record.repository, "snapshot.repository"),
    generatedAt: stringValue(record.generatedAt, "snapshot.generatedAt"),
    issues,
  };
}

function add(
  diagnostics: IssueReadinessDiagnostic[],
  code: IssueReadinessCode,
  issueNumber: number,
  subject: string,
): void {
  diagnostics.push({ code, issueNumber, subject });
}

function count(text: string, needle: string): number {
  let total = 0;
  let cursor = 0;
  while (true) {
    const index = text.indexOf(needle, cursor);
    if (index < 0) {
      return total;
    }
    total += 1;
    cursor = index + needle.length;
  }
}

function issueReferences(text: string): Set<number> {
  const references = new Set<number>();
  for (const match of text.matchAll(ISSUE_REFERENCE)) {
    const value = Number(match[1]);
    if (Number.isSafeInteger(value)) {
      references.add(value);
    }
  }
  return references;
}

function declaredBlockerReferences(body: string, issueNumber: number): Set<number> {
  const references = new Set<number>();
  const currentIssueDeclaration = new RegExp(
    `^\\s*(?:[-*]\\s*)?(?:This issue|This outcome|The issue|The outcome|Issue #${issueNumber}|#${issueNumber}).*?\\b(?:blocked by|open blockers?)\\b\\s*(?:are|is|:)?\\s*(.*)`,
    "i",
  );
  for (const line of body.split("\n")) {
    const plain = line.replaceAll("**", "").replaceAll("`", "");
    if (/\b(?:not blocked by|no open blockers?)\b/i.test(plain)) {
      continue;
    }
    const standardDeclaration = plain.match(
      /^\s*(?:[-*]\s*)?(?:(?:At this audit,\s+the\s+)?Open native blockers(?:\s+at\s+[^:]+)?|Open blockers?|Blocked by(?:\s+for\s+[^:]+)?)\s*(?:are|:)?\s*(.*)/i,
    );
    const currentIssue = plain.match(currentIssueDeclaration);
    const clause = standardDeclaration?.[1] ?? currentIssue?.[1];
    if (clause === undefined) {
      continue;
    }
    const openClause =
      clause.split(/(?:\.\s+(?=[A-Z])|\bClosed\b|\bDelivered foundation\b)/, 1)[0] ?? "";
    for (const blockerNumber of issueReferences(openClause)) {
      references.add(blockerNumber);
    }
  }
  return references;
}

function declaredParentReferences(body: string): ReadonlySet<number> {
  const references = new Set<number>();
  const declaration =
    /\b(?:Parent outcome|Parent issue|Native parent|Child of|Sub-?issue of)\b\s*:?\s*(?:\[\s*)?#(\d+)\b|^\s*-?\s*Parent\s*:\s*(?:\[\s*)?#(\d+)\b/i;
  for (const line of body.split("\n")) {
    const plain = line.replaceAll("**", "").replaceAll("`", "");
    const match = plain.match(declaration);
    const value = Number(match?.[1] ?? match?.[2]);
    if (Number.isSafeInteger(value) && value > 0) {
      references.add(value);
    }
  }
  return references;
}

function normalizedDocumentPath(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value).replaceAll("\\", "/").replace(/^\/+/, "");
    const segments = decoded.split("/");
    if (segments.some((segment) => segment === ".." || segment === "")) {
      return null;
    }
    return segments.join("/");
  } catch {
    return null;
  }
}

function canonicalDocumentPaths(body: string): readonly string[] {
  const paths: string[] = [];
  for (const match of body.matchAll(CANONICAL_DOC_LINK)) {
    const path = normalizedDocumentPath(match[1] ?? "");
    if (path !== null) {
      paths.push(path);
    } else {
      paths.push(match[1] ?? "");
    }
  }
  return paths;
}

function hasHeading(body: string, heading: (typeof REQUIRED_HEADINGS)[number]): boolean {
  return body.split("\n").some((line) => {
    const normalized = line.trim().toLowerCase();
    if (heading === "Completion proof") {
      return (
        normalized === "## accepted terminal outcomes" || /^## .*completion proof$/.test(normalized)
      );
    }
    return normalized === `## ${heading.toLowerCase()}`;
  });
}

function baselineByNumber(
  snapshot: IssueReadinessSnapshot | undefined,
): ReadonlyMap<number, IssueReadinessIssue> {
  return new Map((snapshot?.issues ?? []).map((issue) => [issue.number, issue]));
}

function dependencyCycle(issues: readonly IssueReadinessIssue[]): readonly number[] | null {
  const open = new Set(
    issues.filter((issue) => issue.state === "OPEN").map((issue) => issue.number),
  );
  const edges = new Map<number, number[]>();
  for (const issue of issues) {
    if (!open.has(issue.number)) {
      continue;
    }
    edges.set(
      issue.number,
      issue.blockedBy
        .filter((blocker) => blocker.state === "OPEN" && open.has(blocker.number))
        .map((blocker) => blocker.number)
        .sort((left, right) => left - right),
    );
  }

  const visiting = new Set<number>();
  const visited = new Set<number>();
  const stack: number[] = [];

  function visit(number: number): readonly number[] | null {
    if (visiting.has(number)) {
      const start = stack.indexOf(number);
      return [...stack.slice(start), number];
    }
    if (visited.has(number)) {
      return null;
    }
    visiting.add(number);
    stack.push(number);
    for (const blocker of edges.get(number) ?? []) {
      const cycle = visit(blocker);
      if (cycle !== null) {
        return cycle;
      }
    }
    stack.pop();
    visiting.delete(number);
    visited.add(number);
    return null;
  }

  for (const number of [...open].sort((left, right) => left - right)) {
    const cycle = visit(number);
    if (cycle !== null) {
      return cycle;
    }
  }
  return null;
}

export function auditIssueReadiness(
  snapshot: IssueReadinessSnapshot,
  options: IssueReadinessAuditOptions = {},
): readonly IssueReadinessDiagnostic[] {
  const maximumBodyBytes = options.maximumBodyBytes ?? DEFAULT_MAXIMUM_ISSUE_BODY_BYTES;
  const baseline = baselineByNumber(options.baseline);
  const openIssues = new Map(
    snapshot.issues
      .filter((issue) => issue.state === "OPEN")
      .map((issue) => [issue.number, issue] as const),
  );
  const diagnostics: IssueReadinessDiagnostic[] = [];

  for (const issue of [...snapshot.issues].sort((left, right) => left.number - right.number)) {
    const workTypes = issue.labels.filter((label) => label === "bug" || label.startsWith("type:"));
    if (issue.assignees.length !== 1) {
      add(
        diagnostics,
        "assignee-count",
        issue.number,
        `expected one assignee; found ${issue.assignees.length}`,
      );
    }
    if (workTypes.length !== 1) {
      add(
        diagnostics,
        "work-type-count",
        issue.number,
        `expected one work type; found ${workTypes.length}`,
      );
    }
    if (!issue.labels.some((label) => label.startsWith("area:"))) {
      add(diagnostics, "area-missing", issue.number, "missing area:* label");
    }
    if (issue.milestone === null) {
      add(diagnostics, "milestone-missing", issue.number, "missing milestone");
    }
    const validStatuses = issue.roadmapStatuses.filter((status) => ROADMAP_STATUSES.has(status));
    if (issue.roadmapStatuses.length !== 1 || validStatuses.length !== 1) {
      add(
        diagnostics,
        "roadmap-status-count",
        issue.number,
        `expected one Todo/In Progress/Done status; found ${issue.roadmapStatuses.join(", ") || "none"}`,
      );
    }
    const blockerReferences = declaredBlockerReferences(issue.body, issue.number);
    if (issue.parent === null && issue.subIssues.length === 0 && !declaresStandalone(issue.body)) {
      add(
        diagnostics,
        "planning-relationship-missing",
        issue.number,
        "missing native parent or explicit Standalone declaration",
      );
    }
    if (issue.parent !== null && !declaredParentReferences(issue.body).has(issue.parent.number)) {
      add(
        diagnostics,
        "parent-reference-missing",
        issue.number,
        `native parent #${issue.parent.number} is absent from the body`,
      );
    }
    if (issue.parent?.state === "OPEN") {
      const parent = openIssues.get(issue.parent.number);
      if (
        parent === undefined ||
        !parent.subIssues.some((child) => child.number === issue.number && child.state === "OPEN")
      ) {
        add(
          diagnostics,
          "hierarchy-reciprocity",
          issue.number,
          `open parent #${issue.parent.number} does not list #${issue.number} as an open child`,
        );
      }
    }
    for (const childRelation of issue.subIssues.filter((child) => child.state === "OPEN")) {
      const child = openIssues.get(childRelation.number);
      if (
        child === undefined ||
        child.parent?.number !== issue.number ||
        child.parent.state !== "OPEN"
      ) {
        add(
          diagnostics,
          "hierarchy-reciprocity",
          issue.number,
          `open child #${childRelation.number} does not identify #${issue.number} as its open parent`,
        );
      }
    }

    if (issue.body.trim().length === 0) {
      add(diagnostics, "body-empty", issue.number, "issue body is empty");
    }
    const bodyBytes = Buffer.byteLength(issue.body, "utf8");
    if (bodyBytes > maximumBodyBytes) {
      add(
        diagnostics,
        "body-too-large",
        issue.number,
        `${bodyBytes} bytes exceeds ${maximumBodyBytes}`,
      );
    }
    for (const heading of REQUIRED_HEADINGS) {
      if (!hasHeading(issue.body, heading)) {
        add(diagnostics, "heading-missing", issue.number, `missing ## ${heading}`);
      }
    }

    if (count(issue.body, SHARED_MARKER) > 1) {
      add(
        diagnostics,
        "shared-appendix-duplicate",
        issue.number,
        "shared delivery-governance marker appears more than once",
      );
    }
    if (issue.body.includes(LEGACY_SHARED_MARKER)) {
      add(
        diagnostics,
        "legacy-shared-appendix",
        issue.number,
        "legacy whole-product appendix remains",
      );
    }
    if (count(issue.body, AUDIT_MARKER) > 1) {
      add(
        diagnostics,
        "audit-marker-duplicate",
        issue.number,
        "open-issue audit marker appears more than once",
      );
    }
    if (count(issue.body, "<!--") !== count(issue.body, "-->")) {
      add(diagnostics, "marker-unbalanced", issue.number, "HTML comment markers are unbalanced");
    }

    for (const match of issue.body.matchAll(DECLARED_CHILD_COUNT)) {
      const declared = Number(match[1]);
      if (declared !== issue.subIssues.length) {
        add(
          diagnostics,
          "stale-child-count",
          issue.number,
          `body declares ${declared} native children; live snapshot has ${issue.subIssues.length}`,
        );
      }
    }
    if (issue.subIssues.length > 0 && /^- \*\*Delivery role:\*\* PR-sized\b/im.test(issue.body)) {
      add(
        diagnostics,
        "pr-sized-has-children",
        issue.number,
        `PR-sized issue has ${issue.subIssues.length} native children`,
      );
    }

    const openNativeBlockers = new Set(
      issue.blockedBy
        .filter((blocker) => blocker.state === "OPEN")
        .map((blocker) => blocker.number),
    );
    for (const blocker of [...openNativeBlockers].sort((left, right) => left - right)) {
      if (!blockerReferences.has(blocker)) {
        add(
          diagnostics,
          "open-blocker-not-mentioned",
          issue.number,
          `open native blocker #${blocker} is absent from the body`,
        );
      }
    }
    for (const blocker of [...blockerReferences].sort((left, right) => left - right)) {
      if (!openNativeBlockers.has(blocker)) {
        add(
          diagnostics,
          "prose-blocker-not-native-open",
          issue.number,
          `body calls #${blocker} open/blocked but native open blockers do not include it`,
        );
      }
    }

    if (
      /\b(?:docs|documentation|research)-only\b/i.test(issue.body) &&
      /works through the real Falryn product boundary/i.test(issue.body)
    ) {
      add(
        diagnostics,
        "docs-only-product-completion",
        issue.number,
        "docs/research-only issue requires product-boundary delivery",
      );
    }

    if (OBSOLETE_CANONICAL_OWNER_LINK.test(issue.body)) {
      add(
        diagnostics,
        "canonical-document-owner-invalid",
        issue.number,
        "canonical documentation link uses obsolete yogeshprasad098/falryn-docs owner",
      );
    }

    if (options.documentationPaths !== undefined) {
      for (const path of canonicalDocumentPaths(issue.body)) {
        if (!options.documentationPaths.has(path)) {
          add(
            diagnostics,
            "canonical-document-missing",
            issue.number,
            `canonical documentation path does not exist: ${path}`,
          );
        }
      }
    }

    const previous = baseline.get(issue.number);
    if (previous !== undefined && previous.body === issue.body) {
      if (previous.title !== issue.title) {
        add(
          diagnostics,
          "body-title-drift",
          issue.number,
          `title changed without a body update: ${previous.title} -> ${issue.title}`,
        );
      }
      if (previous.milestone !== issue.milestone) {
        add(
          diagnostics,
          "body-milestone-drift",
          issue.number,
          `milestone changed without a body update: ${previous.milestone ?? "none"} -> ${issue.milestone ?? "none"}`,
        );
      }
    }
  }

  const cycle = dependencyCycle(snapshot.issues);
  if (cycle !== null) {
    add(
      diagnostics,
      "dependency-cycle",
      cycle[0] ?? 0,
      `open dependency cycle: ${cycle.map((number) => `#${number}`).join(" -> ")}`,
    );
  }
  return diagnostics;
}
