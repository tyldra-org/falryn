import { describe, expect, test } from "bun:test";

import { formatGithubIssueList } from "./issue-list.ts";
import { formatGithubPrList } from "./pr-list.ts";
import { formatGithubPrView } from "./pr-view.ts";
import { formatGithubRunList } from "./run-list.ts";

describe("Hush GitHub formats", () => {
  test("keeps every PR and every complete title without a fixed list cap", () => {
    const prs = Array.from({ length: 75 }, (_, index) => ({
      number: index + 1,
      title: `Complete pull request title ${index} with retained tail marker-${index}`,
      state: index % 2 === 0 ? "OPEN" : "CLOSED",
      author: { login: `author-${index}` },
    }));
    const formatted = formatGithubPrList(JSON.stringify(prs));
    expect(formatted?.split("\n")).toHaveLength(75);
    expect(formatted).toContain(
      "#1 open Complete pull request title 0 with retained tail marker-0",
    );
    expect(formatted).toContain(
      "#75 open Complete pull request title 74 with retained tail marker-74",
    );
    expect(formatted).not.toContain("omitted");
    expect(formatted).not.toContain("…");
  });

  test("keeps every issue and complete title", () => {
    const issues = Array.from({ length: 75 }, (_, index) => ({
      number: 700 + index,
      title: `Issue context ${index}`,
      state: "OPEN",
      labels: [{ name: "roadmap" }, { name: `priority:P${index % 4}` }],
    }));
    const formatted = formatGithubIssueList(JSON.stringify(issues));
    expect(formatted?.split("\n")).toHaveLength(75);
    expect(formatted).toContain("#700 open Issue context 0");
    expect(formatted).toContain("#774 open Issue context 74");
  });

  test("keeps every workflow run while making status immediately readable", () => {
    const runs = Array.from({ length: 75 }, (_, index) => ({
      databaseId: 32_600 + index,
      workflowName: index % 2 === 0 ? "CI" : "CodeQL",
      status: index === 74 ? "in_progress" : "completed",
      conclusion: index === 73 ? "failure" : index === 74 ? "" : "success",
    }));
    const formatted = formatGithubRunList(JSON.stringify(runs));
    expect(formatted?.split("\n")).toHaveLength(75);
    expect(formatted).toContain("ok 32600 CI");
    expect(formatted).toContain("fail 32673 CodeQL");
    expect(formatted).toContain("run 32674 CI");
  });

  test("keeps PR identity, check state, URL, and complete body", () => {
    const body = Array.from({ length: 120 }, (_, index) => `body fact ${index}`).join("\n");
    const formatted = formatGithubPrView(
      JSON.stringify({
        number: 784,
        title: "Complete Hush projections",
        state: "OPEN",
        author: { login: "yogeshprasad098" },
        mergeable: "MERGEABLE",
        headRefName: "perf/736-context-optimization",
        baseRefName: "main",
        additions: 120,
        deletions: 24,
        reviews: [{ state: "APPROVED" }, { state: "CHANGES_REQUESTED" }],
        statusCheckRollup: [
          { status: "COMPLETED", conclusion: "SUCCESS" },
          { status: "COMPLETED", conclusion: "SUCCESS" },
          { status: "COMPLETED", conclusion: "FAILURE" },
          { status: "IN_PROGRESS", conclusion: "" },
        ],
        labels: [{ name: "area: context" }],
        assignees: [{ login: "yogeshprasad098" }],
        url: "https://github.com/tyldra-org/falryn/pull/784",
        body,
      }),
    );
    expect(formatted).toContain("#784 open Complete Hush projections");
    expect(formatted).toContain("@yogeshprasad098 | mergeable");
    expect(formatted).toContain("checks 2/4 passed, 1 failed, 1 pending");
    expect(formatted).toContain("body fact 0");
    expect(formatted).toContain("body fact 119");
    expect(formatted).not.toContain("omitted");
  });

  test("understands native gh output when capture enrichment is unavailable", () => {
    expect(
      formatGithubPrList("42\tComplete Hush support\tfeature/hush\tOPEN\t2026-08-23T12:00:00Z\n"),
    ).toBe("#42 open Complete Hush support");
    expect(
      formatGithubIssueList(
        "736\tOPEN\tDo more with less context\troadmap, priority:P0\t2026-08-23T12:00:00Z\n",
      ),
    ).toBe("#736 open Do more with less context");
    expect(
      formatGithubRunList(
        "completed\tsuccess\tHush support\tCI\tfeature/hush\tpull_request\t32642\t2m\t2026-08-23T12:00:00Z\n",
      ),
    ).toBe("ok 32642 CI");
    expect(
      formatGithubPrView(
        "title:\tComplete Hush support\nstate:\tOPEN\nauthor:\tyogesh (Yogesh)\nnumber:\t42\nurl:\thttps://github.com/owner/repo/pull/42\n--\nBody fact\n",
      ),
    ).toBe(
      "#42 open Complete Hush support\n@yogesh\nhttps://github.com/owner/repo/pull/42\n--\nBody fact",
    );
  });
});
