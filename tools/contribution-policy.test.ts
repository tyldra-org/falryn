import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

type Policy = {
  readonly requestedArea: (body: string) => string | null;
  readonly requestedWorkType: (body: string) => string | null;
  readonly validateIssue: (issue: Record<string, unknown>) => readonly string[];
  readonly validateIssueContract: (issue: Record<string, unknown>) => readonly string[];
  readonly validateIssueMetadata: (issue: Record<string, unknown>) => readonly string[];
  readonly validatePullRequest: (pullRequest: Record<string, unknown>) => {
    readonly errors: readonly string[];
    readonly owningIssue: { readonly number: number } | null;
  };
  readonly validateTargetIssue: (
    issue: Record<string, unknown>,
    relations: Record<string, unknown>,
  ) => readonly string[];
};

const require = createRequire(import.meta.url);
const policy = require("../.github/scripts/contribution-policy.cjs") as Policy;

const readyIssueBody = `### Outcome

Deliver bounded behavior.

### Native parent issue

Standalone

### Dependencies and blockers

None

### Completion proof

Run the focused regression test.

### Documentation impact

not-applicable

### Ready checklist

- [x] The contract is verified.
`;

function issue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: "open",
    body: readyIssueBody,
    assignees: [{ login: "owner" }],
    milestone: { title: "v0.4 Extensions and Collaboration" },
    labels: [{ name: "type: feature" }, { name: "area: runtime" }],
    ...overrides,
  };
}

function pullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "feat(runtime): deliver bounded behavior",
    draft: false,
    user: { login: "contributor" },
    body: `## Target and outcome

Closes #123

## Primary change class

- [x] Feature or bug fix
- [ ] Documentation

## Delivery identity

- Delivery owner: @owner

## Compatibility

- [ ] Breaking change
- [x] Backward compatible or not applicable

## Scope

Wire the bounded behavior through the runtime.

## Validation

- \`bun test tools/contribution-policy.test.ts\` — passes.

## Documentation

- Documentation impact: not-applicable
- Companion documentation PR or reason none: no contract changes

## Risk and limitations

The behavior remains local-only.

## Delivery checklist

- [x] The target is Ready.
- [x] The branch is focused.
`,
    ...overrides,
  };
}

describe("contribution policy", () => {
  test("accepts a complete issue and reports missing public contract sections", () => {
    expect(policy.validateIssue(issue())).toEqual([]);
    expect(policy.validateIssue(issue({ body: "### Outcome\n\nOnly an outcome." }))).toContain(
      "complete the Ready checklist section",
    );
  });

  test("separates contributor-owned contract gaps from maintainer metadata", () => {
    const input = issue({
      body: "### Outcome\n\nOnly an outcome.",
      assignees: [],
      milestone: null,
    });
    expect(policy.validateIssueContract(input)).toContain("complete the Ready checklist section");
    expect(policy.validateIssueMetadata(input)).toEqual([
      "assign exactly one GitHub owner",
      "assign exactly one repository milestone",
    ]);
  });

  test("maps the general work form to one canonical work-type label", () => {
    expect(policy.requestedWorkType("### Work type\n\nDocumentation\n")).toBe("type: docs");
    expect(policy.requestedWorkType("### Work type\n\nSomething else\n")).toBeNull();
  });

  test("maps the declared primary area to the canonical label", () => {
    expect(policy.requestedArea("### Primary area\n\nTerminal UI\n")).toBe("area: tui");
    expect(policy.requestedArea("### Primary area\n\nUnknown\n")).toBeNull();
  });

  test("requires one meaningful owning issue and complete PR evidence", () => {
    const valid = policy.validatePullRequest(pullRequest());
    expect(valid.errors).toEqual([]);
    expect(valid.owningIssue?.number).toBe(123);

    const invalid = policy.validatePullRequest(
      pullRequest({ body: "## Target and outcome\n\nRefs #123" }),
    );
    expect(invalid.owningIssue).toBeNull();
    expect(invalid.errors).toContain(
      "put exactly one same-repository closing reference such as `Closes #123` in Target and outcome",
    );
  });

  test("requires a Ready leaf with no open native blockers", () => {
    expect(
      policy.validateTargetIssue(issue(), {
        subIssues: { totalCount: 0 },
        blockedBy: { totalCount: 0, nodes: [] },
      }),
    ).toEqual([]);

    const errors = policy.validateTargetIssue(
      issue({ body: readyIssueBody.replace("[x]", "[ ]") }),
      {
        subIssues: { totalCount: 1 },
        blockedBy: {
          totalCount: 1,
          nodes: [
            {
              number: 9,
              state: "OPEN",
              repository: { nameWithOwner: "tyldra-org/falryn" },
            },
          ],
        },
      },
    );
    expect(errors).toContain(
      "the owning issue must have a non-empty, fully checked Ready checklist",
    );
    expect(errors).toContain("the owning issue must be a PR-sized leaf, not a parent outcome");
    expect(errors).toContain("the owning issue has open blocker(s): tyldra-org/falryn#9");
  });
});
