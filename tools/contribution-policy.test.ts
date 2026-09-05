import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

type Policy = {
  readonly isMaintainerIssue: (issue: Record<string, unknown>) => boolean;
  readonly requestedArea: (body: string) => string | null;
  readonly requestedWorkType: (body: string) => string | null;
  readonly validateIssue: (issue: Record<string, unknown>) => readonly string[];
  readonly validateIssueClassification: (issue: Record<string, unknown>) => readonly string[];
  readonly validateIssueContract: (issue: Record<string, unknown>) => readonly string[];
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

### Dependencies and blockers

None

### Completion proof

Run the focused regression test.

### Documentation impact

not-applicable

### Contribution checklist

- [x] The contract is verified.
`;

const maintainerIssueBody = `## Outcome

Correct the shared runtime behavior.

## Ownership and dependencies

Reuse the existing owner; there are no open blockers.

## Completion proof

Verify the focused regression and shared entrypoint.

## Ready checklist

- [x] The public implementation handoff is complete.
`;

function maintainerIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return issue({
    body: maintainerIssueBody,
    labels: ["roadmap", "type: feature", "area: runtime"],
    ...overrides,
  });
}

function issue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: "open",
    body: readyIssueBody,
    assignees: [],
    milestone: null,
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

async function runIssueWorkflow(
  currentIssue: Record<string, unknown>,
  comments: readonly { id: number; user: { type: string }; body: string }[] = [],
) {
  const workflow = await Bun.file(
    new URL("../.github/workflows/issue-governance.yml", import.meta.url),
  ).text();
  const source = workflow.split("          script: |\n")[1];
  if (source === undefined) throw new Error("Missing governance workflow script");
  const script = source.replace(/^ {12}/gm, "");
  const writes: { operation: string; payload: Record<string, unknown> }[] = [];
  const issues = {
    get: async () => ({ data: { number: 123, ...currentIssue } }),
    listComments: async () => ({ data: comments }),
    createComment: async (payload: Record<string, unknown>) => {
      writes.push({ operation: "create", payload });
    },
    updateComment: async (payload: Record<string, unknown>) => {
      writes.push({ operation: "update", payload });
    },
    deleteComment: async (payload: Record<string, unknown>) => {
      writes.push({ operation: "delete", payload });
    },
  };
  // Execute only this checkout's trusted workflow against in-memory GitHub APIs.
  const execute = new Function(
    "require",
    "github",
    "context",
    `return (async () => {${script}})();`,
  );
  await execute(
    () => policy,
    { rest: { issues }, paginate: async () => comments },
    {
      repo: { owner: "example", repo: "falryn" },
      payload: { issue: { number: 123, body: "outdated event", labels: [] } },
    },
  );
  return writes;
}

describe("contribution policy", () => {
  test("bootstraps before the trusted policy exists on the base revision", async () => {
    const workflow = await Bun.file(
      new URL("../.github/workflows/pr-metadata.yml", import.meta.url),
    ).text();

    expect(workflow).toContain(["ref: $", "{{ github.event.pull_request.base.sha }}"].join(""));
    expect(workflow).toContain("id: trusted_policy");
    expect(workflow).toContain("if: steps.trusted_policy.outputs.available != 'true'");
    expect(workflow).toContain("if: steps.trusted_policy.outputs.available == 'true'");
  });

  test("accepts a complete contribution issue without private planning metadata", () => {
    expect(policy.validateIssue(issue())).toEqual([]);
    expect(policy.validateIssue(issue({ body: "### Outcome\n\nOnly an outcome." }))).toContain(
      "complete the Contribution checklist section",
    );
  });

  test("keeps public classification separate from private planning metadata", () => {
    const input = issue({
      labels: [],
    });
    expect(policy.validateIssueContract(input)).toEqual([]);
    expect(policy.validateIssueClassification(input)).toEqual([
      "apply exactly one work-type label (`bug` or `type:*`)",
      "apply at least one `area:*` label",
    ]);
  });

  test("selects the maintainer format from the repository label, not identity or prose", () => {
    expect(policy.validateIssue(maintainerIssue())).toEqual([]);
    expect(policy.isMaintainerIssue(issue({ author_association: "OWNER" }))).toBe(false);
    const publicIssue = issue({ body: `${maintainerIssueBody}\nroadmap\n` });
    expect(policy.isMaintainerIssue(publicIssue)).toBe(false);
    expect(policy.validateIssue(publicIssue)).toContain(
      "complete the Contribution checklist section",
    );
    expect(
      policy.validateIssue(maintainerIssue({ body: "## Outcome\n\nA real outcome." })),
    ).toEqual(["complete the Completion proof section"]);
    expect(
      policy.validateIssue(maintainerIssue({ labels: ["roadmap", "type: feature"] })),
    ).toContain("apply at least one `area:*` label");
  });

  test("allows maintainer planning but requires its Ready checklist for a delivery PR", () => {
    const planning = maintainerIssue({
      body: maintainerIssueBody.slice(0, maintainerIssueBody.indexOf("## Ready checklist")),
    });
    const relations = { subIssues: { totalCount: 0 }, blockedBy: { totalCount: 0, nodes: [] } };
    expect(policy.validateIssue(planning)).toEqual([]);
    expect(policy.validateTargetIssue(planning, relations)).toContain(
      "the owning issue must have a non-empty, fully checked Ready checklist",
    );
    expect(policy.validateTargetIssue(maintainerIssue(), relations)).toEqual([]);
    expect(
      policy.validateTargetIssue(
        maintainerIssue({ body: maintainerIssueBody.replace("[x]", "[ ]") }),
        relations,
      ),
    ).toContain("the owning issue must have a non-empty, fully checked Ready checklist");
    expect(
      policy.validateTargetIssue(maintainerIssue({ body: readyIssueBody }), relations),
    ).toEqual([]);
    expect(
      policy.validateTargetIssue(maintainerIssue(), {
        subIssues: { totalCount: 2 },
        blockedBy: { totalCount: 1, nodes: [] },
      }),
    ).toEqual([
      "the owning issue must be a PR-sized leaf, not a parent outcome",
      "the owning issue blocker query was truncated",
    ]);
  });

  test("accepts the maintainer auditor's completion-proof headings without relaxing public forms", () => {
    for (const heading of ["Documentation and completion proof", "Accepted terminal outcomes"]) {
      const body = maintainerIssueBody.replace("## Completion proof", `## ${heading}`);
      expect(policy.validateIssue(maintainerIssue({ body }))).toEqual([]);
      expect(policy.validateIssue(issue({ body }))).toContain(
        "complete the Completion proof section",
      );
    }
    expect(
      policy.validateIssue(
        maintainerIssue({
          body: maintainerIssueBody.replace("Completion proof", "Unrelated notes"),
        }),
      ),
    ).toContain("complete the Completion proof section");
  });

  test("reconciles only its bot reminder using fresh issue state", async () => {
    const current = maintainerIssue({
      labels: [{ name: "roadmap" }, { name: "type: feature" }, { name: "area: runtime" }],
    });
    const body = "<!-- falryn-issue-governance -->\nOld public-form reminder";
    const humanComment = { id: 1, user: { type: "User" }, body };
    const unrelatedBot = { id: 2, user: { type: "Bot" }, body: "Other automation" };
    expect(await runIssueWorkflow(current, [humanComment, unrelatedBot])).toEqual([]);
    expect(
      await runIssueWorkflow(current, [
        humanComment,
        unrelatedBot,
        { id: 3, user: { type: "Bot" }, body },
      ]),
    ).toEqual([
      { operation: "delete", payload: { owner: "example", repo: "falryn", comment_id: 3 } },
    ]);
  });

  test("creates actionable reminders once and does not rewrite unchanged comments", async () => {
    const input = issue({ body: "## Outcome\n\nNeeds planning." });
    const writes = await runIssueWorkflow(input);
    expect(writes).toHaveLength(1);
    const reminder = writes[0];
    if (reminder === undefined || typeof reminder.payload.body !== "string") {
      throw new Error("Expected a reminder body");
    }
    expect(reminder.operation).toBe("create");
    expect(reminder.payload.body).toContain("public contribution contract");
    const existing = { id: 7, user: { type: "Bot" }, body: reminder.payload.body };
    expect(await runIssueWorkflow(input, [existing])).toEqual([]);
    const changed = await runIssueWorkflow(
      maintainerIssue({
        body: "## Outcome\n\nNeeds planning.",
        labels: [{ name: "roadmap" }, { name: "type: feature" }, { name: "area: runtime" }],
      }),
      [existing],
    );
    expect(changed[0]?.operation).toBe("update");
    expect(changed[0]?.payload.body).toContain("maintainer issue contract");
    expect(changed[0]?.payload.body).not.toContain("Contribution checklist");
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

  test("requires a contribution-ready leaf with no open native blockers", () => {
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
      "the owning issue must have a non-empty, fully checked Contribution checklist",
    );
    expect(errors).toContain("the owning issue must be a PR-sized leaf, not a parent outcome");
    expect(errors).toContain("the owning issue has open blocker(s): tyldra-org/falryn#9");
  });
});
