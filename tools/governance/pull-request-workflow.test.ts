import { describe, expect, test } from "bun:test";

type Job = {
  if?: string;
  needs?: string;
  permissions?: Record<string, string>;
  concurrency?: { group: string };
  steps: { uses?: string; with?: Record<string, string> }[];
};
type Workflow = {
  on: Record<string, { types?: string[]; branches?: string[]; paths?: string[] }>;
  permissions: Record<string, string>;
  concurrency?: unknown;
  jobs: Record<string, Job>;
};
const workflow = Bun.YAML.parse(
  await Bun.file(new URL("../../.github/workflows/pr-checks.yml", import.meta.url)).text(),
) as Workflow;

// Evaluate the workflow's own event predicates against representative GitHub
// payloads. Job dependencies and matrix expansion remain GitHub's responsibility.
function selectedJobs(eventName: string, action: string): string[] {
  return Object.entries(workflow.jobs)
    .filter(([, job]) => {
      if (job.needs) return false;
      if (!job.if) return true;
      return new Function("github", "contains", "fromJSON", `return (${job.if});`)(
        { event_name: eventName, event: { action } },
        (values: string[], value: string) => values.includes(value),
        JSON.parse,
      );
    })
    .map(([name]) => name)
    .sort();
}

describe("pull request workflow trust boundaries", () => {
  test.each(["opened", "edited", "reopened", "synchronize", "ready_for_review"])(
    "PR %s runs only read-only metadata validation",
    (action) => {
      expect(workflow.on.pull_request?.types).toContain(action);
      expect(selectedJobs("pull_request", action)).toEqual(["validate"]);
      expect(workflow.jobs.validate?.permissions ?? workflow.permissions).toEqual({
        contents: "read",
        issues: "read",
        "pull-requests": "read",
      });
      expect(workflow.jobs.validate?.steps[0]?.with?.ref).toBe(
        ["$", "{{ github.event.pull_request.base.sha }}"].join(""),
      );
    },
  );

  test.each(["opened", "reopened", "synchronize", "ready_for_review", "converted_to_draft"])(
    "trusted PR %s retains its labeling scope",
    (action) => {
      expect(workflow.on.pull_request_target?.types).toContain(action);
      expect(selectedJobs("pull_request_target", action)).toEqual(
        ["ready_for_review", "converted_to_draft"].includes(action)
          ? ["collect"]
          : ["area", "collect", "size"],
      );
    },
  );

  test("comments and trust-list pushes only select vouch targets", () => {
    expect(workflow.on.issue_comment?.types).toEqual(["created"]);
    expect(workflow.on.push?.branches).toEqual(["main"]);
    expect(workflow.on.push?.paths).toEqual([
      ".github/VOUCHED.td",
      ".github/workflows/pr-checks.yml",
    ]);
    expect(selectedJobs("issue_comment", "created")).toEqual(["collect"]);
    expect(selectedJobs("push", "")).toEqual(["collect"]);
    expect(workflow.jobs.label?.needs).toBe("collect");
    expect(workflow.jobs.label?.if).toBe("needs.collect.outputs.targets != '[]'");
  });

  test("label writers cannot execute a checked-out PR or cancel each other", () => {
    expect(workflow.concurrency).toBeUndefined();
    const groups = [];
    for (const name of ["area", "size", "label"]) {
      const job = workflow.jobs[name];
      expect(job?.permissions).toEqual({
        contents: "read",
        issues: "write",
        "pull-requests": "write",
      });
      expect(job?.steps.some((step) => step.uses?.startsWith("actions/checkout@"))).toBe(false);
      expect(job?.concurrency?.group).toBeDefined();
      groups.push(job?.concurrency?.group);
    }
    expect(new Set(groups).size).toBe(3);
  });
});
