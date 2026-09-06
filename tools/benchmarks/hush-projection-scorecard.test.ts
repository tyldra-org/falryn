import { describe, expect, test } from "bun:test";

import { HUSH_BUILD_OPERATION_CASES } from "./hush-build-operation-cases.ts";
import { HUSH_CLOUD_INFRA_CASES } from "./hush-cloud-infra-cases.ts";
import { HUSH_CONTAINER_CASES } from "./hush-container-cases.ts";
import { HUSH_KUBERNETES_CASES } from "./hush-kubernetes-cases.ts";
import { HUSH_NETWORK_CASES } from "./hush-network-cases.ts";
import {
  HUSH_FIND_LISTING_PATHS,
  HUSH_PROJECTION_CASES,
  HUSH_PROJECTION_CORPUS_VERSION,
} from "./hush-projection-scorecard.ts";

describe("Hush projection scorecard corpus", () => {
  test("keeps each supported Git mutation as a separate RTK comparison", () => {
    expect(HUSH_PROJECTION_CORPUS_VERSION).toBe("hush-projections.v33");
    expect(
      HUSH_PROJECTION_CASES.filter((entry) => entry.projection === "git-mutation").map(
        (entry) => entry.id,
      ),
    ).toEqual([
      "git-add",
      "git-branch",
      "git-checkout",
      "git-commit",
      "git-fetch",
      "git-push",
      "git-pull",
      "git-stash",
      "git-worktree",
    ]);
  });

  test("compares Git and external unified diffs independently", () => {
    const diffs = HUSH_PROJECTION_CASES.filter((entry) => entry.projection === "git-diff");
    expect(diffs.map((entry) => entry.id)).toEqual([
      "git-diff",
      "git-diff-stat",
      "git-diff-name-status",
      "git-diff-large-complete",
      "external-diff",
    ]);
    const git = HUSH_PROJECTION_CASES.find((entry) => entry.id === "git-diff");
    expect(git?.requiredMarkers).toHaveLength(14);
    expect(git?.forbiddenMarkers).toContain("--- a/");
    expect(git?.forbiddenMarkers).toContain("omitted");
    const large = HUSH_PROJECTION_CASES.find((entry) => entry.id === "git-diff-large-complete");
    expect(large?.rtkArgv).toContain("--no-compact");
    expect(large?.requiredMarkers).toContain("-before-80");
    expect(large?.requiredMarkers).toContain("+after-80");
    const external = HUSH_PROJECTION_CASES.find((entry) => entry.id === "external-diff");
    expect(external?.acceptedExitCodes).toEqual([1]);
    expect(external?.forbiddenMarkers).toContain("omitted");
  });

  test("compares uncapped Git log and complete Git show projections independently", () => {
    const history = HUSH_PROJECTION_CASES.filter((entry) => entry.projection === "git-log");
    expect(history.map((entry) => entry.id)).toEqual(["git-log", "git-show"]);
    const log = HUSH_PROJECTION_CASES.find((entry) => entry.id === "git-log");
    expect(log?.argv).toContain("-3");
    expect(log?.requiredMarkers).toContain(
      "33333333 2026-08-24 Review Agent | Keep the final commit",
    );
    expect(log?.forbiddenMarkers).toContain("omitted");
    const show = HUSH_PROJECTION_CASES.find((entry) => entry.id === "git-show");
    expect(show?.requiredMarkers).toHaveLength(16);
    expect(show?.requiredMarkers).toContain("export const reducer = 'git.show'");
    expect(show?.forbiddenMarkers).toContain("--- a/");
  });

  test("locks the large find listing that exposed RTK path omission", () => {
    const listing = HUSH_PROJECTION_CASES[0];
    expect(listing).toBeDefined();
    if (listing === undefined) throw new Error("missing find scorecard case");
    expect(listing.id).toBe("listing-find");
    expect(HUSH_FIND_LISTING_PATHS).toHaveLength(67);
    expect(listing.requiredMarkers).toHaveLength(12);
    expect(listing.forbiddenMarkers).toContain("+17 more");
  });

  test("keeps each supported GitHub read as a separate RTK comparison", () => {
    expect(
      HUSH_PROJECTION_CASES.filter((entry) => entry.executable === "gh").map((entry) => entry.id),
    ).toEqual([
      "gh-pr-list",
      "gh-pr-view",
      "gh-issue-list",
      "gh-run-list",
      "gh-repo-view",
      "gh-api",
      "gh-release-list",
    ]);
    const issueList = HUSH_PROJECTION_CASES.find((entry) => entry.id === "gh-issue-list");
    expect(issueList?.argv).toEqual(["issue", "list", "--limit", "20"]);
    expect(issueList?.requiredMarkers).toContain(
      "790 Implement registry-driven slash completion and command aliases",
    );
    const runList = HUSH_PROJECTION_CASES.find((entry) => entry.id === "gh-run-list");
    expect(runList?.argv).toEqual(["run", "list", "--limit", "10"]);
    expect(runList?.requiredMarkers).toContain("cancel 32606 32607");
  });

  test("keeps each requested GitLab command as a separate RTK comparison", () => {
    expect(
      HUSH_PROJECTION_CASES.filter((entry) => entry.executable === "glab").map((entry) => entry.id),
    ).toEqual([
      "glab-mr-list",
      "glab-issue-list",
      "glab-ci-status",
      "glab-pipeline-list",
      "glab-api",
      "glab-release-list",
    ]);
    expect(
      HUSH_PROJECTION_CASES.filter((entry) => entry.executable === "glab").every((entry) =>
        entry.forbiddenMarkers?.includes("omitted"),
      ),
    ).toBe(true);
    expect(HUSH_PROJECTION_CASES.find((entry) => entry.id === "glab-pipeline-list")?.baseline).toBe(
      "raw",
    );
    expect(
      HUSH_PROJECTION_CASES.filter(
        (entry) => entry.executable === "glab" && entry.id !== "glab-api",
      ).every((entry) => entry.competitiveTarget === "win"),
    ).toBe(true);
    expect(HUSH_PROJECTION_CASES.find((entry) => entry.id === "glab-api")?.competitiveTarget).toBe(
      "tie",
    );
  });

  test("keeps each requested Graphite command as a separate RTK comparison", () => {
    expect(
      HUSH_PROJECTION_CASES.filter((entry) => entry.executable === "gt").map((entry) => entry.id),
    ).toEqual(["gt-log", "gt-submit", "gt-sync", "gt-restack", "gt-create", "gt-branch"]);
    expect(
      HUSH_PROJECTION_CASES.filter((entry) => entry.executable === "gt").every((entry) =>
        entry.forbiddenMarkers?.includes("omitted"),
      ),
    ).toBe(true);
    expect(
      HUSH_PROJECTION_CASES.filter((entry) =>
        ["gt-sync", "gt-restack", "gt-create"].includes(entry.id),
      ).every((entry) => "baseline" in entry && entry.baseline === "raw"),
    ).toBe(true);
    expect(
      HUSH_PROJECTION_CASES.filter((entry) => entry.executable === "gt").every(
        (entry) => entry.competitiveTarget === "win",
      ),
    ).toBe(true);
  });

  test("keeps Jira list and view complete while requiring strict wins", () => {
    const jira = HUSH_PROJECTION_CASES.filter((entry) => entry.executable === "jira");
    expect(jira.map((entry) => entry.id)).toEqual(["jira-issue-list", "jira-issue-view"]);
    expect(jira.every((entry) => entry.competitiveTarget === "win")).toBe(true);
    expect(jira.every((entry) => entry.forbiddenMarkers?.includes("omitted"))).toBe(true);
    expect(jira.find((entry) => entry.id === "jira-issue-list")?.requiredMarkers).toHaveLength(4);
    expect(jira.find((entry) => entry.id === "jira-issue-view")?.requiredMarkers).toHaveLength(9);
  });

  test("keeps each requested typecheck surface complete and requires a strict win", () => {
    const diagnostics = HUSH_PROJECTION_CASES.filter(
      (entry) =>
        ["tsc", "basedpyright", "ty"].includes(entry.executable) ||
        (entry.executable === "bun" && entry.id === "diagnostic-bun-typecheck"),
    );
    expect(diagnostics.map((entry) => entry.id)).toEqual([
      "diagnostic-tsc",
      "diagnostic-basedpyright",
      "diagnostic-ty",
      "diagnostic-bun-typecheck",
    ]);
    expect(diagnostics.every((entry) => entry.projection === "diagnostic")).toBe(true);
    expect(
      diagnostics.every(
        (entry) => "competitiveTarget" in entry && entry.competitiveTarget === "win",
      ),
    ).toBe(true);
    expect(
      diagnostics.every(
        (entry) =>
          "forbiddenMarkers" in entry &&
          (entry.forbiddenMarkers as readonly string[]).includes("omitted"),
      ),
    ).toBe(true);
  });

  test("measures every requested lint, format, and diagnostic surface as an uncapped strict win", () => {
    const diagnostics = HUSH_PROJECTION_CASES.filter(
      (entry) =>
        entry.projection === "diagnostic" &&
        !entry.id.includes("typecheck") &&
        !["diagnostic-tsc", "diagnostic-basedpyright", "diagnostic-ty"].includes(entry.id),
    );
    expect(diagnostics.map((entry) => entry.id)).toEqual([
      "diagnostic-format-generic",
      "diagnostic-lint-generic",
      "diagnostic-biome",
      "diagnostic-eslint",
      "diagnostic-oxlint",
      "diagnostic-prettier",
      "diagnostic-bun-check",
      "diagnostic-bun-lint",
      "diagnostic-cargo-clippy",
      "diagnostic-cargo-check",
      "diagnostic-cargo-fmt",
      "diagnostic-clippy",
      "diagnostic-mypy",
      "diagnostic-python-mypy",
      "diagnostic-ruff-check",
      "diagnostic-ruff-format",
      "diagnostic-go-vet",
      "diagnostic-golangci-lint",
      "diagnostic-golangci",
      "diagnostic-dotnet-format",
      "diagnostic-mix-format",
      "diagnostic-phpstan",
      "diagnostic-ecs",
      "diagnostic-pint",
      "diagnostic-rubocop",
      "diagnostic-bundle-rubocop",
      "diagnostic-precommit",
      "diagnostic-hadolint",
      "diagnostic-markdownlint",
      "diagnostic-shellcheck",
      "diagnostic-yamllint",
    ]);
    expect(diagnostics).toHaveLength(31);
    expect(
      diagnostics.every(
        (entry) => "competitiveTarget" in entry && entry.competitiveTarget === "win",
      ),
    ).toBe(true);
    expect(
      diagnostics.every(
        (entry) =>
          "forbiddenMarkers" in entry &&
          (entry.forbiddenMarkers as readonly string[]).includes("omitted"),
      ),
    ).toBe(true);
  });

  test("measures every requested build and operation surface without unsafe reductions", () => {
    expect(HUSH_BUILD_OPERATION_CASES).toHaveLength(47);
    const ids: readonly string[] = HUSH_BUILD_OPERATION_CASES.map((entry) => entry.id);
    expect(ids).toEqual(
      HUSH_PROJECTION_CASES.filter((entry) =>
        HUSH_BUILD_OPERATION_CASES.some((candidate) => candidate.id === entry.id),
      ).map((entry) => entry.id),
    );
    const ties = HUSH_BUILD_OPERATION_CASES.filter(
      (entry) => ("competitiveTarget" in entry ? entry.competitiveTarget : "tie") === "tie",
    ).map((entry) => entry.id);
    expect(ties).toEqual([
      "build-go",
      "operation-php",
      "operation-php-lint",
      "operation-ollama",
      "operation-java",
    ]);
    expect(
      HUSH_BUILD_OPERATION_CASES.every((entry) => entry.forbiddenMarkers.includes("omitted")),
    ).toBe(true);
  });

  test("measures every requested container surface without unsafe reductions", () => {
    expect(HUSH_CONTAINER_CASES).toHaveLength(23);
    const ids: readonly string[] = HUSH_CONTAINER_CASES.map((entry) => entry.id);
    expect(ids).toEqual(
      HUSH_PROJECTION_CASES.filter((entry) =>
        HUSH_CONTAINER_CASES.some((candidate) => candidate.id === entry.id),
      ).map((entry) => entry.id),
    );
    expect(ids).toContain("container-docker-compose-ps");
    expect(ids).toContain("container-podman-compose-logs");
    expect(ids).toContain("container-skopeo-copy");
    expect(
      HUSH_CONTAINER_CASES.filter((entry) => entry.baseline === "raw").map((entry) => entry.id),
    ).toEqual([
      "container-docker-ps",
      "container-docker-images",
      "container-docker-compose-ps",
      "container-docker-compose-logs",
      "container-skopeo-copy",
    ]);
    expect(
      HUSH_CONTAINER_CASES.every((entry) => entry.forbiddenMarkers?.includes("omitted") ?? false),
    ).toBe(true);
  });

  test("measures every requested Kubernetes and OpenShift surface without unsafe reductions", () => {
    expect(HUSH_KUBERNETES_CASES).toHaveLength(19);
    const ids: readonly string[] = HUSH_KUBERNETES_CASES.map((entry) => entry.id);
    expect(ids).toEqual(
      HUSH_PROJECTION_CASES.filter((entry) =>
        HUSH_KUBERNETES_CASES.some((candidate) => candidate.id === entry.id),
      ).map((entry) => entry.id),
    );
    expect(ids).toContain("kubernetes-kubectl-get-pods-wide");
    expect(ids).toContain("kubernetes-kubectl-prefix-logs");
    expect(ids).toContain("kubernetes-kubectl-describe");
    expect(ids).toContain("kubernetes-oc-adm-top");
    expect(
      HUSH_KUBERNETES_CASES.filter((entry) => entry.baseline === "raw").map((entry) => entry.id),
    ).toEqual([
      "kubernetes-kubectl-get-pods",
      "kubernetes-kubectl-pods",
      "kubernetes-kubectl-services",
      "kubernetes-kubectl-get-pods-wide",
      "kubernetes-oc-get-pods",
      "kubernetes-kubectl-logs",
      "kubernetes-kubectl-prefix-logs",
      "kubernetes-kubectl-arbitrary-logs",
      "kubernetes-oc-logs",
    ]);
    expect(
      HUSH_KUBERNETES_CASES.every((entry) => entry.forbiddenMarkers?.includes("omitted") ?? false),
    ).toBe(true);
  });

  test("measures every requested cloud and infrastructure surface without unsafe reductions", () => {
    expect(HUSH_CLOUD_INFRA_CASES).toHaveLength(38);
    const ids: readonly string[] = HUSH_CLOUD_INFRA_CASES.map((entry) => entry.id);
    expect(ids).toEqual(
      HUSH_PROJECTION_CASES.filter((entry) =>
        HUSH_CLOUD_INFRA_CASES.some((candidate) => candidate.id === entry.id),
      ).map((entry) => entry.id),
    );
    expect(ids.filter((id) => id.startsWith("cloud-aws-"))).toHaveLength(15);
    expect(ids).toContain("cloud-gcloud-projects");
    expect(ids).toContain("cloud-az-group");
    expect(ids).toContain("infra-ansible");
    expect(ids).toContain("infra-pulumi-stack-list");
    expect(ids).toContain("infra-terraform-plan");
    expect(ids).toContain("infra-tofu-validate");
    expect(
      HUSH_CLOUD_INFRA_CASES.every((entry) => entry.forbiddenMarkers?.includes("omitted") ?? false),
    ).toBe(true);
    expect(
      HUSH_CLOUD_INFRA_CASES.filter((entry) => entry.competitiveTarget !== "win").map(
        (entry) => entry.id,
      ),
    ).toEqual(["infra-sops", "infra-terraform-fmt", "infra-tofu-fmt"]);
    expect(
      HUSH_CLOUD_INFRA_CASES.filter((entry) => entry.baseline === "raw").map((entry) => entry.id),
    ).toEqual([
      "cloud-aws-ec2",
      "cloud-aws-rds",
      "cloud-aws-cloudformation",
      "cloud-aws-logs",
      "cloud-aws-lambda",
      "cloud-aws-iam",
      "infra-pulumi-preview",
      "infra-pulumi-up",
      "infra-pulumi-destroy",
      "infra-pulumi-refresh",
    ]);
  });

  test("measures every requested HTTP and network surface without unsafe reductions", () => {
    expect(HUSH_NETWORK_CASES).toHaveLength(15);
    expect(HUSH_NETWORK_CASES.map((entry) => entry.id)).toEqual([
      "curl-json",
      "curl-headers-json",
      "curl-events",
      "curl-failure-body",
      "wget-download",
      "wget-explicit-output",
      "wget-stdout-json",
      "wget-redirect",
      "wget-failure",
      "ping-darwin",
      "ping-linux",
      "rsync-transfer",
      "rsync-dry-run",
      "ssh-json",
      "ssh-text",
    ]);
    expect(
      HUSH_NETWORK_CASES.filter((entry) => entry.baseline === "raw").map((entry) => entry.id),
    ).toEqual([
      "curl-failure-body",
      "wget-stdout-json",
      "wget-redirect",
      "wget-failure",
      "ping-darwin",
      "ping-linux",
      "rsync-transfer",
      "rsync-dry-run",
    ]);
    expect(
      HUSH_NETWORK_CASES.filter((entry) => entry.competitiveTarget !== "win").map(
        (entry) => entry.id,
      ),
    ).toEqual(["ssh-text"]);
    expect(
      HUSH_NETWORK_CASES.every((entry) => entry.forbiddenMarkers?.includes("omitted") ?? false),
    ).toBe(true);
  });

  test("measures every requested test-runner and wrapper as an uncapped strict win", () => {
    const runners = HUSH_PROJECTION_CASES.filter((entry) => entry.projection === "test");
    expect(runners.map((entry) => entry.id)).toEqual([
      "test-generic",
      "test-jest",
      "test-vitest",
      "test-playwright",
      "test-mocha",
      "test-bun",
      "test-pytest",
      "test-python-pytest",
      "test-uv-pytest",
      "test-cargo",
      "test-cargo-nextest",
      "test-go",
      "test-gradle",
      "test-gradlew",
      "test-maven",
      "test-maven-integration",
      "test-sbt",
      "test-dotnet",
      "test-swift",
      "test-xcodebuild",
      "test-phpunit",
      "test-pest",
      "test-paratest",
      "test-php-vendor",
      "test-rake",
      "test-rails",
      "test-rspec",
      "test-bundle-rspec",
    ]);
    expect(runners.every((entry) => entry.competitiveTarget === "win")).toBe(true);
    expect(runners.every((entry) => entry.forbiddenMarkers?.includes("omitted"))).toBe(true);
  });

  test("compares journalctl with RTK log while requiring every event fact", () => {
    const logs = HUSH_PROJECTION_CASES.filter((entry) => entry.projection === "log");
    expect(logs.map((entry) => entry.id)).toEqual([
      "container-docker-logs",
      "container-docker-compose-logs",
      "container-podman-logs",
      "container-podman-compose-logs",
      "kubernetes-kubectl-logs",
      "kubernetes-kubectl-prefix-logs",
      "kubernetes-kubectl-arbitrary-logs",
      "kubernetes-oc-logs",
      "log-journalctl",
    ]);
    const journal = HUSH_PROJECTION_CASES.find((entry) => entry.id === "log-journalctl");
    expect(journal?.baseline).toBe("rtk-log");
    expect(journal?.requiredMarkers).toHaveLength(7);
    expect(journal?.forbiddenMarkers).toContain("omitted");
  });

  test("keeps every JavaScript package surface separate and enforces its win or tie target", () => {
    const packages = HUSH_PROJECTION_CASES.filter(
      (entry) =>
        entry.projection === "package" &&
        ["npm", "pnpm", "yarn", "bun", "npx", "pnpx"].includes(entry.executable),
    );
    expect(packages.map((entry) => entry.id)).toEqual([
      "package-npm-install",
      "package-npm-list",
      "package-npm-outdated",
      "package-npm-run",
      "package-pnpm-install",
      "package-pnpm-list",
      "package-pnpm-outdated",
      "package-pnpm-run",
      "package-yarn-install",
      "package-yarn-list",
      "package-yarn-outdated",
      "package-yarn-run",
      "package-bun-install",
      "package-bun-add",
      "package-bun-outdated",
      "package-bun-run",
      "package-bun-audit",
      "package-bun-pm-list",
      "package-npx",
      "package-pnpx",
    ]);
    expect(packages.every((entry) => entry.projection === "package")).toBe(true);
    const optimized = packages.filter(
      (entry) => !["package-bun-audit", "package-bun-pm-list"].includes(entry.id),
    );
    expect(
      optimized.every((entry) => "competitiveTarget" in entry && entry.competitiveTarget === "win"),
    ).toBe(true);
    expect(
      packages
        .filter((entry) => ["package-bun-audit", "package-bun-pm-list"].includes(entry.id))
        .every((entry) => "competitiveTarget" in entry && entry.competitiveTarget === "tie"),
    ).toBe(true);
    expect(
      packages.every(
        (entry) =>
          "forbiddenMarkers" in entry &&
          (entry.forbiddenMarkers as readonly string[]).includes("omitted"),
      ),
    ).toBe(true);
  });

  test("keeps every requested Python and ecosystem package surface uncapped and competitive", () => {
    const packages = HUSH_PROJECTION_CASES.filter(
      (entry) =>
        entry.projection === "package" &&
        ["pip", "pip3", "uv", "poetry", "brew", "composer", "bundle"].includes(entry.executable),
    );
    expect(packages.map((entry) => entry.id)).toEqual([
      "package-pip-install",
      "package-pip-list",
      "package-pip3-outdated",
      "package-uv-sync",
      "package-poetry-install",
      "package-brew-install",
      "package-composer-install",
      "package-bundle-install",
    ]);
    expect(packages.every((entry) => entry.projection === "package")).toBe(true);
    expect(
      packages.every((entry) => "competitiveTarget" in entry && entry.competitiveTarget === "win"),
    ).toBe(true);
    expect(
      packages.every(
        (entry) =>
          "forbiddenMarkers" in entry &&
          (entry.forbiddenMarkers as readonly string[]).includes("omitted"),
      ),
    ).toBe(true);
    expect(
      packages.every(
        (entry) =>
          "forbiddenMarkers" in entry &&
          (entry.forbiddenMarkers as readonly string[]).includes("…"),
      ),
    ).toBe(true);
  });

  test("compares single and multi-file wc without dropping count facts", () => {
    const counts = HUSH_PROJECTION_CASES.filter((entry) => entry.projection === "count");
    expect(counts.map((entry) => entry.id)).toEqual(["count-wc-single", "count-wc-multi"]);
    expect(counts.every((entry) => entry.requiredMarkers.length >= 3)).toBe(true);
    expect(counts.every((entry) => entry.forbiddenMarkers?.includes("omitted"))).toBe(true);
  });

  test("compares complete PostgreSQL tables through the pinned RTK reducer", () => {
    const psql = HUSH_PROJECTION_CASES.filter((entry) => entry.executable === "psql");
    expect(psql.map((entry) => entry.id)).toEqual(["data-psql-table", "data-psql-expanded"]);
    expect(psql.every((entry) => entry.projection === "structured")).toBe(true);
    expect(psql.every((entry) => entry.rtkArgv?.[0] === "psql")).toBe(true);
    expect(psql.every((entry) => entry.forbiddenMarkers?.includes("omitted"))).toBe(true);
  });

  test("compares SQLite human display modes through RTK passthrough", () => {
    const sqlite = HUSH_PROJECTION_CASES.filter((entry) => entry.executable === "sqlite3");
    expect(sqlite.map((entry) => entry.id)).toEqual([
      "data-sqlite-column",
      "data-sqlite-box",
      "data-sqlite-line",
    ]);
    expect(sqlite.every((entry) => entry.projection === "structured")).toBe(true);
    expect(sqlite.every((entry) => entry.rtkArgv?.[0] === "sqlite3")).toBe(true);
    expect(sqlite.every((entry) => entry.forbiddenMarkers?.includes("omitted"))).toBe(true);
  });

  test("compares every supported system table command without accepting missing facts", () => {
    const system = HUSH_PROJECTION_CASES.filter((entry) =>
      ["df", "du", "ps", "stat", "systemctl"].includes(entry.executable),
    );
    expect(system.map((entry) => entry.id)).toEqual([
      "system-df",
      "system-du",
      "system-ps",
      "system-stat",
      "system-systemctl",
    ]);
    expect(system.every((entry) => entry.projection === "table")).toBe(true);
    expect(
      system.every((entry) => "rtkArgv" in entry && entry.rtkArgv[0] === entry.executable),
    ).toBe(true);
    expect(
      system.every(
        (entry) =>
          "forbiddenMarkers" in entry &&
          (entry.forbiddenMarkers as readonly string[]).includes("omitted"),
      ),
    ).toBe(true);
  });

  test("covers ripgrep, sed, pipelines, and and-chains independently", () => {
    expect(
      HUSH_PROJECTION_CASES.filter((entry) =>
        [
          "search-rg",
          "transform-sed",
          "compound-rg-sed-pipe",
          "compound-pipe-rg",
          "compound-rg-and-sed",
        ].includes(entry.id),
      ).map((entry) => entry.id),
    ).toEqual([
      "search-rg",
      "transform-sed",
      "compound-rg-sed-pipe",
      "compound-pipe-rg",
      "compound-rg-and-sed",
    ]);
  });
});
