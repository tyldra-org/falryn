import { describe, expect, test } from "bun:test";

type Job = {
  if?: string;
  needs?: string;
  permissions?: Record<string, string>;
  concurrency?: { group: string };
  steps: { uses?: string; with?: Record<string, string | boolean> }[];
};
type Workflow = {
  on: Record<string, { types?: string[]; branches?: string[]; paths?: string[] }>;
  permissions: Record<string, string>;
  concurrency?: unknown;
  jobs: Record<string, Job>;
};
async function load(name: string): Promise<Workflow> {
  const text = await Bun.file(new URL(`../../.github/workflows/${name}`, import.meta.url)).text();
  return Bun.YAML.parse(text) as Workflow;
}
const checks = await load("pr-checks.yml");
const labels = await load("pr-labels.yml");

type Event = {
  readonly name: string;
  readonly action?: string;
  readonly comment?: string;
  readonly onPullRequest?: boolean;
};

// Evaluate the workflow's own event predicates against representative GitHub
// payloads. Job dependencies and matrix expansion remain GitHub's responsibility.
function selectedJobs(workflow: Workflow, event: Event): string[] {
  const github = {
    event_name: event.name,
    event: {
      action: event.action ?? "",
      comment: { body: event.comment ?? "" },
      issue: { pull_request: event.onPullRequest ? {} : null },
    },
  };
  return Object.entries(workflow.jobs)
    .filter(([, job]) => {
      if (job.needs) return false;
      if (!job.if) return true;
      return new Function("github", "contains", `return (${job.if});`)(
        github,
        (haystack: string | string[], needle: string) => haystack.includes(needle),
      );
    })
    .map(([name]) => name)
    .sort();
}

const DEFAULT_BRANCH = ["$", "{{ github.event.repository.default_branch }}"].join("");

describe("pull request workflow trust boundaries", () => {
  test.each(["opened", "edited", "reopened", "synchronize", "ready_for_review"])(
    "PR %s runs only read-only metadata validation from the base revision",
    (action) => {
      expect(Object.keys(checks.on)).toEqual(["pull_request"]);
      expect(checks.on.pull_request?.types).toContain(action);
      expect(selectedJobs(checks, { name: "pull_request", action })).toEqual(["validate"]);
      expect(checks.jobs.validate?.permissions ?? checks.permissions).toEqual({
        contents: "read",
        issues: "read",
        "pull-requests": "read",
      });
      expect(checks.jobs.validate?.steps[0]?.with?.ref).toBe(
        ["$", "{{ github.event.pull_request.base.sha }}"].join(""),
      );
    },
  );

  test.each(["opened", "reopened", "synchronize"])(
    "trusted PR %s applies every label",
    (action) => {
      expect(labels.on.pull_request_target?.types).toContain(action);
      expect(selectedJobs(labels, { name: "pull_request_target", action })).toEqual([
        "area",
        "collect",
        "size",
      ]);
    },
  );

  test("only /recheck-vouch on a pull request, or a trust-list push, selects vouch targets", () => {
    expect(labels.on.issue_comment?.types).toEqual(["created"]);
    expect(labels.on.push?.branches).toEqual(["main"]);
    expect(labels.on.push?.paths).toEqual([
      ".github/VOUCHED.td",
      ".github/workflows/pr-labels.yml",
    ]);
    const comment = (body: string, onPullRequest: boolean) =>
      selectedJobs(labels, { name: "issue_comment", comment: body, onPullRequest });
    expect(comment("please /recheck-vouch", true)).toEqual(["collect"]);
    expect(comment("looks good", true)).toEqual([]);
    expect(comment("/recheck-vouch", false)).toEqual([]);
    expect(selectedJobs(labels, { name: "push" })).toEqual(["collect"]);
    expect(labels.jobs.vouch?.needs).toBe("collect");
    expect(labels.jobs.vouch?.if).toBe("needs.collect.outputs.targets != '[]'");
  });

  test("label writers never check out the pull request head or cancel each other", () => {
    expect(labels.permissions).toEqual({ contents: "read" });
    expect(labels.concurrency).toBeUndefined();
    const groups = [];
    for (const name of ["area", "size", "vouch"]) {
      const job = labels.jobs[name];
      expect(job?.permissions).toEqual({
        contents: "read",
        issues: "write",
        "pull-requests": "write",
      });
      // A checkout is the trusted base or default branch only, without a stored token.
      for (const step of job?.steps ?? [])
        if (step.uses?.startsWith("actions/checkout@")) {
          expect([undefined, DEFAULT_BRANCH]).toContain(step.with?.ref as string | undefined);
          expect(step.with?.["persist-credentials"]).toBe(false);
        }
      expect(job?.concurrency?.group).toBeDefined();
      groups.push(job?.concurrency?.group);
    }
    expect(new Set(groups).size).toBe(3);
  });
});
