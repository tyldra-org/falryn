"use strict";

const REQUIRED_ISSUE_SECTIONS = [
  "Outcome",
  "Dependencies and blockers",
  "Completion proof",
  "Documentation impact",
  "Contribution checklist",
];

const REQUIRED_PR_SECTIONS = [
  "Target and outcome",
  "Primary change class",
  "Compatibility",
  "Delivery identity",
  "Scope",
  "Validation",
  "Documentation",
  "Risk and limitations",
  "Delivery checklist",
];

const DOCUMENTATION_RESULTS = new Set([
  "public-code-adjacent-update",
  "private-update-required",
  "private-verify-unaffected",
  "private-verification-unavailable",
  "not-applicable",
]);

const REQUESTED_WORK_TYPES = new Map([
  ["Documentation", "type: docs"],
  ["Infrastructure and maintenance", "type: infrastructure"],
  ["Research and qualification", "type: research"],
]);

const REQUESTED_AREAS = new Map([
  ["Runtime and application", "area: runtime"],
  ["CLI and headless use", "area: cli"],
  ["Providers and models", "area: providers"],
  ["Terminal UI", "area: tui"],
  ["Language intelligence", "area: language"],
  ["Tools and execution", "area: tools"],
  ["Context and compression", "area: context"],
  ["Data, persistence, and artifacts", "area: data"],
  ["Memory", "area: memory"],
  ["Agents and workflows", "area: agents"],
  ["Extensions and marketplace", "area: extensions"],
  ["Web and browser", "area: web"],
  ["Performance", "area: performance"],
  ["Release and compatibility", "area: release"],
  ["Security and privacy", "area: security"],
  ["Documentation", "area: docs"],
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function section(body, heading) {
  const pattern = new RegExp(
    `^#{2,6}\\s+${escapeRegExp(heading)}\\s*$([\\s\\S]*?)(?=^#{2,6}\\s+|(?![\\s\\S]))`,
    "im",
  );
  return pattern.exec(body)?.[1]?.trim() ?? null;
}

function withoutComments(value) {
  return value.replace(/<!--[\s\S]*?-->/g, "").trim();
}

function checkboxCounts(value) {
  return {
    checked: [...value.matchAll(/^\s*- \[[xX]\]\s+/gm)].length,
    unchecked: [...value.matchAll(/^\s*- \[ \]\s+/gm)].length,
  };
}

function narrative(value) {
  return withoutComments(value)
    .split("\n")
    .filter((line) => !/^\s*- \[[ xX]\]\s+/.test(line))
    .filter((line) => !/^\s*[-*]?\s*[A-Za-z][A-Za-z ]+:\s*$/.test(line))
    .join("\n")
    .trim();
}

function labelsOf(issue) {
  return (issue.labels ?? []).map((label) => (typeof label === "string" ? label : label.name));
}

// This public label selects a body format, not private Project membership or
// readiness. Those facts remain the responsibility of the maintainer auditors.
function isMaintainerIssue(issue) {
  return labelsOf(issue).includes("roadmap");
}

function issueChecklist(issue) {
  const body = issue.body ?? "";
  // Adopted public contributions can retain their original form.
  return isMaintainerIssue(issue) && section(body, "Contribution checklist") === null
    ? "Ready checklist"
    : "Contribution checklist";
}

function maintainerCompletionProof(body) {
  // Keep the heading vocabulary aligned with tools/issue-readiness.ts.
  for (const match of body.matchAll(/^#{2,3}\s+(.+)$/gm)) {
    const heading = match[1].trim();
    if (/(?:completion proof$|^accepted terminal outcomes$)/i.test(heading)) {
      const value = section(body, heading);
      if (value !== null && withoutComments(value).length > 0) return value;
    }
  }
  return null;
}

function requestedWorkType(body) {
  const value = section(body ?? "", "Work type");
  return value === null ? null : (REQUESTED_WORK_TYPES.get(withoutComments(value)) ?? null);
}

function requestedArea(body) {
  const value = section(body ?? "", "Primary area");
  return value === null ? null : (REQUESTED_AREAS.get(withoutComments(value)) ?? null);
}

function validateIssueClassification(issue) {
  if (issue.state !== "open") return [];

  const errors = [];
  const labels = labelsOf(issue);
  const workTypes = labels.filter((label) => label === "bug" || label.startsWith("type:"));

  if (workTypes.length !== 1) {
    errors.push("apply exactly one work-type label (`bug` or `type:*`)");
  }
  if (!labels.some((label) => label.startsWith("area:"))) {
    errors.push("apply at least one `area:*` label");
  }
  return errors;
}

function validateIssueContract(issue) {
  if (issue.state !== "open") return [];

  const errors = [];
  const body = issue.body ?? "";
  const headings = isMaintainerIssue(issue)
    ? ["Outcome", "Completion proof"]
    : REQUIRED_ISSUE_SECTIONS;
  for (const heading of headings) {
    const value =
      isMaintainerIssue(issue) && heading === "Completion proof"
        ? maintainerCompletionProof(body)
        : section(body, heading);
    if (value === null || withoutComments(value).length === 0) {
      errors.push(`complete the ${heading} section`);
    }
  }
  const checklistHeading = issueChecklist(issue);
  const checklist = section(body, checklistHeading);
  if (checklist !== null) {
    const counts = checkboxCounts(checklist);
    if (counts.checked + counts.unchecked === 0) {
      errors.push(`include at least one item in the ${checklistHeading}`);
    }
  }
  return errors;
}

function validateIssue(issue) {
  return [...validateIssueContract(issue), ...validateIssueClassification(issue)];
}

function parseOwningIssue(body) {
  const target = section(body, "Target and outcome");
  if (target === null) return null;
  const matches = [
    ...withoutComments(target).matchAll(
      /^\s*(closes?|fix(?:es|ed)?|resolves?)\s+(?:(?:tyldra-org\/falryn)?#)(\d+)\s*$/gim,
    ),
  ];
  if (matches.length !== 1) return null;
  return { keyword: matches[0][1], number: Number(matches[0][2]) };
}

function fieldValue(value, label) {
  const match = new RegExp(`^\\s*-?\\s*${escapeRegExp(label)}:\\s*(.+?)\\s*$`, "im").exec(value);
  return match?.[1]?.trim() ?? null;
}

function validatePullRequest(pullRequest) {
  if (pullRequest.user?.login === "dependabot[bot]") {
    return { errors: [], owningIssue: null };
  }

  const errors = [];
  const body = pullRequest.body ?? "";
  const conventionalTitle =
    /^(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|test)(?:\([A-Za-z0-9._/-]+\))?!?: .+$/;
  if (!conventionalTitle.test(pullRequest.title)) {
    errors.push(
      "use a conventional PR title such as `feat(tui): add search` or `fix: preserve exit status`",
    );
  }

  for (const heading of REQUIRED_PR_SECTIONS) {
    if (section(body, heading) === null) {
      errors.push(`include the ## ${heading} section`);
    }
  }

  const owningIssue = parseOwningIssue(body);
  if (owningIssue === null) {
    errors.push(
      "put exactly one same-repository closing reference such as `Closes #123` in Target and outcome",
    );
  }

  const changeClass = section(body, "Primary change class");
  if (changeClass !== null && checkboxCounts(changeClass).checked !== 1) {
    errors.push("select exactly one Primary change class");
  }

  const compatibility = section(body, "Compatibility");
  if (compatibility !== null && checkboxCounts(compatibility).checked !== 1) {
    errors.push("select exactly one Compatibility result");
  }

  const deliveryIdentity = section(body, "Delivery identity");
  if (deliveryIdentity !== null && fieldValue(deliveryIdentity, "Delivery owner") === null) {
    errors.push("name the Delivery owner");
  }

  for (const heading of ["Scope", "Validation", "Risk and limitations"]) {
    const value = section(body, heading);
    if (value !== null && narrative(value).length === 0) {
      errors.push(`record concrete evidence in ${heading}`);
    }
  }

  const documentation = section(body, "Documentation");
  if (documentation !== null) {
    const impact = fieldValue(documentation, "Documentation impact");
    const results =
      impact
        ?.split(/[,+|]/)
        .map((value) => value.trim())
        .filter(Boolean) ?? [];
    if (
      results.length === 0 ||
      results.some((result) => !DOCUMENTATION_RESULTS.has(result)) ||
      (results.includes("not-applicable") && results.length !== 1)
    ) {
      errors.push(
        "record valid Documentation impact result(s); `not-applicable` must be exclusive",
      );
    }
    if (fieldValue(documentation, "Companion documentation PR or reason none") === null) {
      errors.push("link the companion documentation PR or record why none exists");
    }
  }

  const delivery = section(body, "Delivery checklist");
  if (delivery !== null && !pullRequest.draft) {
    const counts = checkboxCounts(delivery);
    if (counts.checked === 0 || counts.unchecked > 0) {
      errors.push("complete every Delivery checklist item before requesting review");
    }
  }

  return { errors, owningIssue };
}

function validateTargetIssue(issue, relations) {
  const errors = [];
  if (issue.state !== "open") {
    errors.push("the owning issue must still be open");
  }

  const checklistHeading = issueChecklist(issue);
  const checklist = section(issue.body ?? "", checklistHeading);
  const counts = checklist === null ? { checked: 0, unchecked: 0 } : checkboxCounts(checklist);
  if (counts.checked === 0 || counts.unchecked > 0) {
    errors.push(`the owning issue must have a non-empty, fully checked ${checklistHeading}`);
  }
  if ((relations.subIssues?.totalCount ?? 0) > 0) {
    errors.push("the owning issue must be a PR-sized leaf, not a parent outcome");
  }
  if ((relations.blockedBy?.totalCount ?? 0) !== (relations.blockedBy?.nodes?.length ?? 0)) {
    errors.push("the owning issue blocker query was truncated");
  }
  const openBlockers = (relations.blockedBy?.nodes ?? []).filter(
    (blocker) => blocker.state === "OPEN",
  );
  if (openBlockers.length > 0) {
    errors.push(
      `the owning issue has open blocker(s): ${openBlockers
        .map((blocker) => `${blocker.repository.nameWithOwner}#${blocker.number}`)
        .sort()
        .join(", ")}`,
    );
  }
  return errors;
}

module.exports = {
  checkboxCounts,
  isMaintainerIssue,
  parseOwningIssue,
  requestedArea,
  requestedWorkType,
  section,
  validateIssue,
  validateIssueClassification,
  validateIssueContract,
  validatePullRequest,
  validateTargetIssue,
};
