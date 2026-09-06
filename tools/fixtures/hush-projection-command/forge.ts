export function ghOutput(argv: readonly string[]): string {
  const command = `${argv[0] ?? ""} ${argv[1] ?? ""}`;
  const json = argv.includes("--json");
  switch (command) {
    case "pr list": {
      const prs = [
        {
          number: 128,
          title: "Context engine groundwork",
          state: "OPEN",
          author: { login: "falryn-dev" },
          headRefName: "feat/context-engine",
          updatedAt: "2026-08-23T12:00:00Z",
        },
        {
          number: 736,
          title: "Do more with less context",
          state: "OPEN",
          author: { login: "yogeshprasad098" },
          headRefName: "perf/736-context-optimization",
          updatedAt: "2026-08-23T12:01:00Z",
        },
        {
          number: 784,
          title: "Complete Hush projections",
          state: "OPEN",
          author: { login: "yogeshprasad098" },
          headRefName: "perf/736-context-optimization",
          updatedAt: "2026-08-23T12:02:00Z",
        },
      ];
      return json
        ? JSON.stringify(prs)
        : prs
            .map(
              (pr) => `${pr.number}\t${pr.title}\t${pr.headRefName}\t${pr.state}\t${pr.updatedAt}`,
            )
            .join("\n");
    }
    case "pr view": {
      const pr = {
        number: 784,
        title: "Complete Hush projections",
        state: "OPEN",
        author: { login: "yogeshprasad098" },
        body: "## Outcome\n\nPreserve every useful PR fact.\n\n- No list truncation\n- Hush-native output",
        url: "https://github.com/tyldra-org/falryn/pull/784",
        mergeable: "MERGEABLE",
        reviews: [{ state: "APPROVED" }],
        statusCheckRollup: [
          { name: "TypeScript", status: "COMPLETED", conclusion: "SUCCESS" },
          { name: "Tests", status: "COMPLETED", conclusion: "SUCCESS" },
          { name: "CodeQL", status: "COMPLETED", conclusion: "FAILURE" },
        ],
        labels: [{ name: "area: context" }],
        assignees: [{ login: "yogeshprasad098" }],
        headRefName: "perf/736-context-optimization",
        baseRefName: "main",
        additions: 120,
        deletions: 24,
      };
      return json
        ? JSON.stringify(pr)
        : [
            `title:\t${pr.title}`,
            `state:\t${pr.state}`,
            "author:\tyogeshprasad098 (Yogesh Prasad)",
            "labels:\tarea: context",
            "assignees:\tyogeshprasad098",
            `number:\t${pr.number}`,
            `url:\t${pr.url}`,
            `additions:\t${pr.additions}`,
            `deletions:\t${pr.deletions}`,
            "--",
            pr.body,
          ].join("\n");
    }
    case "issue list": {
      const issues = [
        [809, "Implement live browser supervision, screencast, and human takeover"],
        [808, "Implement browser diagnostics, testing, accessibility, and performance tools"],
        [807, "Qualify local and remote browser adapters, installation, and readiness"],
        [806, "Expose Falryn capabilities to external agent hosts through a bounded MCP bridge"],
        [805, "Harden registered LSP and DAP tools with strict contracts and live edit feedback"],
        [804, "Qualify optional semantic retrieval beyond lexical, precise, and graph baselines"],
        [803, "Persist code relationships and build token-budgeted repository maps"],
        [802, "Wire precise LSP intelligence and structural search into product retrieval"],
        [801, "Make workspace index root-qualified, incremental, and FTS5-queryable"],
        [800, "Qualify optional native acceleration kernels behind TypeScript contracts"],
        [
          798,
          "Wire provider connections and authorized authentication through product entrypoints",
        ],
        [797, "Implement durable goals and bounded iterative loop control"],
        [796, "Expose per-command raw-output mode for process tools"],
        [795, "Add safe worktree create and remove actions to the Git dashboard"],
        [794, "Complete durable session naming and pinning in OpenTUI"],
        [793, "Implement bounded transcript and conversation search"],
        [792, "Expose manual history compact, checkpoint restore, and durable undo controls"],
        [791, "Make semantic session history artifact-complete and forensically recoverable"],
        [790, "Implement registry-driven slash completion and command aliases"],
        [789, "Implement Ask, Plan, Debug, and Agent execution profiles"],
      ].map(([number, title], index) => ({
        number,
        title,
        state: "OPEN",
        labels: [{ name: index % 2 === 0 ? "priority:P0" : "priority:P1" }],
        updatedAt: `2026-08-23T12:${String(index).padStart(2, "0")}:00Z`,
      }));
      return json
        ? JSON.stringify(issues)
        : issues
            .map(
              (issue) =>
                `${issue.number}\t${issue.state}\t${issue.title}\t${issue.labels
                  .map((label) => label.name)
                  .join(", ")}\t${issue.updatedAt}`,
            )
            .join("\n");
    }
    case "run list": {
      const runs = [
        {
          databaseId: 32601,
          status: "completed",
          conclusion: "skipped",
        },
        { databaseId: 32602, status: "completed", conclusion: "skipped" },
        { databaseId: 32603, status: "completed", conclusion: "skipped" },
        { databaseId: 32604, status: "completed", conclusion: "skipped" },
        { databaseId: 32605, status: "completed", conclusion: "skipped" },
        { databaseId: 32606, status: "completed", conclusion: "cancelled" },
        { databaseId: 32607, status: "completed", conclusion: "cancelled" },
        { databaseId: 32608, status: "completed", conclusion: "success" },
        { databaseId: 32609, status: "completed", conclusion: "failure" },
        { databaseId: 32610, status: "in_progress", conclusion: "" },
      ].map((run, index) => ({
        ...run,
        name: "Issue governance",
        workflowName: "Issue governance",
        createdAt: `2026-08-23T12:${String(index).padStart(2, "0")}:00Z`,
      }));
      return json
        ? JSON.stringify(runs)
        : runs
            .map(
              (run) =>
                `${run.status}\t${run.conclusion}\tHush projection validation\t${run.workflowName}\tperf/736-context-optimization\tpull_request\t${run.databaseId}\t1m\t${run.createdAt}`,
            )
            .join("\n");
    }
    case "repo view": {
      const repository = {
        name: "falryn",
        nameWithOwner: "tyldra-org/falryn",
        owner: { login: "tyldra-org" },
        visibility: "PUBLIC",
        isPrivate: false,
        isArchived: false,
        description: "A local terminal coding agent built with Bun, TypeScript, and OpenTUI.",
        stargazerCount: 2,
        forkCount: 1,
        url: "https://github.com/tyldra-org/falryn",
      };
      return json
        ? JSON.stringify(repository)
        : [
            "name:\ttyldra-org/falryn",
            "description:\tA local terminal coding agent built with Bun, TypeScript, and OpenTUI.",
            "--",
            "# Falryn",
            "A local terminal coding agent for deliberate, inspectable work.",
          ].join("\n");
    }
    case "api repos/tyldra-org/falryn":
      return JSON.stringify({ name: "falryn", private: false, default_branch: "main" });
    case "release list": {
      const releases = [
        {
          tagName: "v0.2.0",
          name: "Falryn 0.2.0",
          isLatest: true,
          isDraft: false,
          isPrerelease: false,
          publishedAt: "2026-08-24T12:00:00Z",
          createdAt: "2026-08-24T11:00:00Z",
        },
        {
          tagName: "v0.3.0-beta",
          name: "Falryn 0.3 beta",
          isLatest: false,
          isDraft: false,
          isPrerelease: true,
          publishedAt: "2026-08-23T12:00:00Z",
          createdAt: "2026-08-23T11:00:00Z",
        },
      ];
      return json
        ? JSON.stringify(releases)
        : [
            "Falryn 0.2.0\tLatest\tv0.2.0\t2026-08-24T12:00:00Z",
            "Falryn 0.3 beta\tPre-release\tv0.3.0-beta\t2026-08-23T12:00:00Z",
          ].join("\n");
    }
    default:
      return "";
  }
}

export function glabOutput(argv: readonly string[]): string {
  const command = `${argv[0] ?? ""} ${argv[1] ?? ""}`;
  const json = outputValue(argv) === "json";
  switch (command) {
    case "mr list": {
      const mergeRequests = [
        {
          iid: 128,
          title: "Context engine groundwork",
          state: "opened",
          source_branch: "feat/context-engine",
          target_branch: "main",
          author: { username: "falryn-dev" },
          web_url: "https://gitlab.example/tyldra/falryn/-/merge_requests/128",
        },
        {
          iid: 736,
          title: "Do more with less context",
          state: "opened",
          source_branch: "perf/736-context-optimization",
          target_branch: "main",
          author: { username: "yogeshprasad098" },
          web_url: "https://gitlab.example/tyldra/falryn/-/merge_requests/736",
        },
        {
          iid: 784,
          title: "Complete Hush projections",
          state: "opened",
          source_branch: "perf/736-context-optimization",
          target_branch: "main",
          author: { username: "yogeshprasad098" },
          web_url: "https://gitlab.example/tyldra/falryn/-/merge_requests/784",
        },
      ];
      return json
        ? JSON.stringify(mergeRequests)
        : [
            "Showing 3 open merge requests on tyldra/falryn. (Page 1)",
            ...mergeRequests.map(
              (mr) =>
                `!${mr.iid} ${mr.title} (${mr.source_branch} -> ${mr.target_branch}) @${mr.author.username}`,
            ),
          ].join("\n");
    }
    case "issue list": {
      const issues = [
        {
          iid: 809,
          title: "Implement live browser supervision and human takeover",
          state: "opened",
          author: { username: "yogeshprasad098" },
          labels: ["priority:P0", "area: browser"],
          web_url: "https://gitlab.example/tyldra/falryn/-/issues/809",
        },
        {
          iid: 800,
          title: "Qualify optional native acceleration kernels",
          state: "opened",
          author: { username: "yogeshprasad098" },
          labels: ["priority:P1", "area: performance"],
          web_url: "https://gitlab.example/tyldra/falryn/-/issues/800",
        },
        {
          iid: 790,
          title: "Implement registry-driven slash completion",
          state: "opened",
          author: { username: "yogeshprasad098" },
          labels: ["priority:P1", "area: tui"],
          web_url: "https://gitlab.example/tyldra/falryn/-/issues/790",
        },
      ];
      return json
        ? JSON.stringify(issues)
        : [
            "Showing 3 open issues on tyldra/falryn. (Page 1)",
            ...issues.map(
              (issue) =>
                `#${issue.iid} ${issue.title} [${issue.labels.join(", ")}] @${issue.author.username}`,
            ),
          ].join("\n");
    }
    case "ci status": {
      const status = {
        pipeline: {
          id: 901,
          status: "failed",
          ref: "perf/736-context-optimization",
          sha: "abcdef0123456789abcdef0123456789abcdef01",
          web_url: "https://gitlab.example/tyldra/falryn/-/pipelines/901",
        },
        jobs: [
          {
            id: 1_001,
            name: "typecheck",
            stage: "verify",
            status: "success",
            allow_failure: false,
            failure_reason: "",
          },
          {
            id: 1_002,
            name: "tests",
            stage: "verify",
            status: "failed",
            allow_failure: false,
            failure_reason: "script_failure",
          },
          {
            id: 1_003,
            name: "codeql",
            stage: "security",
            status: "failed",
            allow_failure: true,
            failure_reason: "script_failure",
          },
        ],
      };
      return json
        ? JSON.stringify(status)
        : [
            "(success) • 32s  verify    typecheck",
            "(failed) • 1m12s verify    tests",
            "(failed) • 52s  security  codeql",
            "https://gitlab.example/tyldra/falryn/-/pipelines/901",
            "SHA: abcdef0123456789abcdef0123456789abcdef01",
            "Pipeline state: failed",
          ].join("\n");
    }
    case "pipeline list": {
      const pipelines = [
        {
          id: 901,
          status: "failed",
          ref: "perf/736-context-optimization",
          sha: "abcdef0123456789abcdef0123456789abcdef01",
          source: "push",
          name: "verify",
          web_url: "https://gitlab.example/tyldra/falryn/-/pipelines/901",
        },
        {
          id: 900,
          status: "success",
          ref: "main",
          sha: "1234567890abcdef1234567890abcdef12345678",
          source: "merge_request_event",
          name: "verify",
          web_url: "https://gitlab.example/tyldra/falryn/-/pipelines/900",
        },
      ];
      return json
        ? JSON.stringify(pipelines)
        : [
            "Showing 2 pipelines on tyldra/falryn. (Page 1)",
            "(failed) • #901 perf/736-context-optimization abcdef01 push",
            "(success) • #900 main 12345678 merge_request_event",
          ].join("\n");
    }
    case "api projects/736":
      return JSON.stringify({
        id: 736,
        path_with_namespace: "tyldra/falryn",
        visibility: "public",
      });
    case "release list": {
      const releases = [
        {
          tag_name: "v0.2.0",
          name: "Falryn 0.2.0",
          upcoming_release: false,
          released_at: "2026-08-24T12:00:00Z",
          created_at: "2026-08-24T11:00:00Z",
          _links: { self: "https://gitlab.example/tyldra/falryn/-/releases/v0.2.0" },
        },
        {
          tag_name: "v0.3.0-beta",
          name: "Falryn 0.3 beta",
          upcoming_release: true,
          released_at: "2026-09-01T12:00:00Z",
          created_at: "2026-08-24T12:00:00Z",
          _links: { self: "https://gitlab.example/tyldra/falryn/-/releases/v0.3.0-beta" },
        },
      ];
      return json
        ? JSON.stringify(releases)
        : [
            "Showing 2 releases on tyldra/falryn.",
            "v0.2.0 Falryn 0.2.0 released 2026-08-24",
            "v0.3.0-beta Falryn 0.3 beta upcoming 2026-09-01",
          ].join("\n");
    }
    default:
      return "";
  }
}

function outputValue(argv: readonly string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if ((argument === "--output" || argument === "-F" || argument === "-O") && argv[index + 1]) {
      return argv[index + 1] ?? null;
    }
    const inline = /^(?:--output|-F|-O)=(.+)$/u.exec(argument)?.[1];
    if (inline !== undefined) {
      return inline;
    }
  }
  return null;
}

export function graphiteOutput(argv: readonly string[]): string {
  switch (argv[0]) {
    case "log":
      return [
        "◉ feature/top (current)",
        "│ 8 seconds ago",
        "│",
        "│ 95338df - Preserve complete context",
        "│",
        "◯ feature/base",
        "│ 2 minutes ago",
        "│",
        "│ 95610c6 - Build Hush forge reducers",
        "│",
        "◯ main",
        "│ 5 weeks ago",
      ].join("\n");
    case "submit":
      return [
        "🥞 Validating that this Graphite stack is ready to submit...",
        "📝 Preparing to submit PRs for the following branches...",
        "▸ feature/base (Create)",
        "▸ feature/top (Update)",
        "📨 Pushing to remote and creating/updating PRs...",
        "feature/base: https://app.graphite.dev/github/pr/example/repo/101 (created)",
        "feature/top: https://app.graphite.dev/github/pr/example/repo/102 (updated)",
      ].join("\n");
    case "sync":
      return [
        "🌲 Fetching latest changes from remote...",
        "main is up to date.",
        "🧹 Cleaning up merged branches...",
        "Deleted feature/merged (PR #98 was merged).",
        "🔄 Restacking branches...",
        "Restacked feature/base on main.",
        "Restacked feature/top on feature/base.",
      ].join("\n");
    case "restack":
      return [
        "🔄 Restacking branches...",
        "Restacked feature/base on main.",
        "Restacked feature/top on feature/base.",
      ].join("\n");
    case "create":
      return [
        "Created branch feature/demo on main.",
        "[feature/demo abc1234] Preserve complete context",
        " 2 files changed, 6 insertions(+), 1 deletion(-)",
      ].join("\n");
    case "branch":
      return ["◉ feature/top (current)", "◯ feature/base", "◯ main"].join("\n");
    default:
      return "";
  }
}

export function jiraOutput(argv: readonly string[]): string {
  const command = `${argv[0] ?? ""} ${argv[1] ?? ""}`;
  switch (command) {
    case "issue list":
      return [
        "TYPE   KEY      SUMMARY                              STATUS       ASSIGNEE       REPORTER       PRIORITY  RESOLUTION  CREATED              UPDATED              LABELS",
        "Task   FAL-736  Optimize context engines             In Progress  Yogesh Prasad  Yogesh Prasad  High                  2026-08-23 10:15:00  2026-08-25 09:40:00  context,performance",
        "Bug    FAL-788  Wire live index candidates           To Do        Yogesh Prasad  Yogesh Prasad  Highest               2026-08-24 08:30:00  2026-08-25 08:55:00  index,context",
        "Story  FAL-806  Expose bounded capability bridge     Done         Yogesh Prasad  Yogesh Prasad  Normal    Fixed       2026-08-24 14:20:00  2026-08-25 07:15:00  mcp,capability",
      ].join("\n");
    case "issue view":
      return [
        "Task  In Progress  Sun, 23 Aug 26  Yogesh Prasad  FAL-736  3 comments  2 linked",
        "# Optimize context engines",
        "Tue, 25 Aug 26  Yogesh Prasad  High  Context Platform  context, performance",
        "",
        "------------------------ Description ------------------------",
        "",
        "Make Hush, Loom, Brief, indexing, and context packing preserve every useful fact while reducing total turn cost.",
        "",
        "------------------------ 2 Subtasks ------------------------",
        "",
        "FAL-788 Wire live index candidates • Highest • To Do",
        "FAL-806 Expose bounded capability bridge • Normal • Done",
        "",
        "View this issue on Jira: https://jira.example.test/browse/FAL-736",
      ].join("\n");
    default:
      return "";
  }
}
