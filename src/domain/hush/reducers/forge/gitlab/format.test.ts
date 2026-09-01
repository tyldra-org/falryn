import { describe, expect, test } from "bun:test";

import { formatGitlabCiStatus } from "./ci-status.ts";
import { formatGitlabIssueList } from "./issue-list.ts";
import { formatGitlabMrList } from "./mr-list.ts";
import { formatGitlabPipelineList } from "./pipeline-list.ts";
import { formatGitlabReleaseList } from "./release-list.ts";

describe("Hush GitLab formats", () => {
  test("keeps every MR with state and branches", () => {
    const entries = Array.from({ length: 75 }, (_, index) => ({
      iid: index + 1,
      title: `Merge request ${index} tail-${index}`,
      state: index % 2 === 0 ? "opened" : "merged",
      source_branch: `feature/${index}`,
      target_branch: "main",
      author: { username: `author-${index}` },
      web_url: `https://gitlab.example/group/repo/-/merge_requests/${index + 1}`,
    }));
    const formatted = formatGitlabMrList(JSON.stringify(entries), ["--all"]);
    expect(formatted?.split("\n")).toHaveLength(76);
    expect(formatted).toStartWith("-> main:\n");
    expect(formatted).toContain("!1 feature/0: open Merge request 0 tail-0");
    expect(formatted).toContain("!75 feature/74: open Merge request 74 tail-74");
    expect(formatted).not.toContain("omitted");
  });

  test("factors repeated source branches only when that reduces bytes", () => {
    const formatted = formatGitlabMrList(
      JSON.stringify([
        {
          iid: 736,
          title: "Do more with less context",
          state: "opened",
          source_branch: "perf/736-context-optimization",
          target_branch: "main",
        },
        {
          iid: 784,
          title: "Complete Hush projections",
          state: "opened",
          source_branch: "perf/736-context-optimization",
          target_branch: "main",
        },
      ]),
    );
    expect(formatted).toBe(
      "-> main:\nperf/736-context-optimization:\n!736 Do more with less context\n!784 Complete Hush projections",
    );
  });

  test("keeps every issue and complete title", () => {
    const entries = Array.from({ length: 75 }, (_, index) => ({
      iid: 700 + index,
      title: `Issue ${index}`,
      state: "opened",
      author: { username: `author-${index}` },
      labels: ["roadmap", `priority:P${index % 4}`],
      web_url: `https://gitlab.example/group/repo/-/issues/${700 + index}`,
    }));
    const formatted = formatGitlabIssueList(JSON.stringify(entries));
    expect(formatted?.split("\n")).toHaveLength(75);
    expect(formatted).toContain("#700 Issue 0");
    expect(formatted).toContain("#774 Issue 74");
  });

  test("keeps every pipeline identity and target", () => {
    const entries = Array.from({ length: 75 }, (_, index) => ({
      id: 900 + index,
      status: index === 74 ? "failed" : "success",
      ref: index % 2 === 0 ? "main" : "feature/context",
      sha: `${String(index).padStart(8, "0")}abcdef0123456789`,
      source: "push",
      name: "verify",
      web_url: `https://gitlab.example/group/repo/-/pipelines/${900 + index}`,
    }));
    const formatted = formatGitlabPipelineList(JSON.stringify(entries));
    expect(formatted?.split("\n")).toHaveLength(75);
    expect(formatted).toContain("#900 ok main@00000000 push verify");
    expect(formatted).toContain("#974 fail main@00000074 push verify");
  });

  test("keeps the pipeline and every job including allowed failures", () => {
    const jobs = Array.from({ length: 75 }, (_, index) => ({
      id: 1_000 + index,
      name: `job-${index}`,
      stage: index % 2 === 0 ? "test" : "build",
      status: index === 74 ? "failed" : "success",
      allow_failure: index === 74,
      failure_reason: index === 74 ? "script_failure" : "",
    }));
    const formatted = formatGitlabCiStatus(
      JSON.stringify({
        pipeline: {
          id: 901,
          status: "failed",
          ref: "main",
          sha: "abcdef0123456789",
          web_url: "https://gitlab.example/group/repo/-/pipelines/901",
        },
        jobs,
      }),
    );
    expect(formatted?.split("\n")).toHaveLength(77);
    expect(formatted).toContain(
      "#901 fail main@abcdef01 https://gitlab.example/group/repo/-/pipelines/901",
    );
    expect(formatted).toContain("fail #1074 job-74 [test] allowed script_failure");
    expect(formatted).not.toContain("omitted");
  });

  test("keeps every release and upcoming state", () => {
    const entries = Array.from({ length: 75 }, (_, index) => ({
      tag_name: `v1.${index}.0`,
      name: `Falryn ${index}`,
      upcoming_release: index === 74,
      released_at: `2026-08-${String((index % 28) + 1).padStart(2, "0")}T12:00:00Z`,
      created_at: `2026-08-${String((index % 28) + 1).padStart(2, "0")}T11:00:00Z`,
      _links: { self: `https://gitlab.example/group/repo/-/releases/v1.${index}.0` },
    }));
    const formatted = formatGitlabReleaseList(JSON.stringify(entries));
    expect(formatted?.split("\n")).toHaveLength(75);
    expect(formatted).toContain("release v1.0.0 Falryn 0 2026-08-01");
    expect(formatted).toContain("upcoming v1.74.0 Falryn 74 2026-08-19");
  });

  test("declines malformed structured output instead of guessing", () => {
    expect(formatGitlabMrList('[{"iid":1,"title":"missing facts"}]')).toBeNull();
    expect(formatGitlabCiStatus('{"pipeline":{},"jobs":[]}')).toBeNull();
  });
});
