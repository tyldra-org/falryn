export function gitOutput(argv: readonly string[]): string {
  const subcommand = gitSubcommand(argv);
  switch (subcommand) {
    case "status":
      return [
        "## main...origin/main [ahead 1]",
        " M src/domain/hush.ts",
        " M src/domain/hush/reducers/plain-text.ts",
        "?? tools/hush-projection-scorecard.ts",
      ].join("\n");
    case "diff":
      if (argv.includes("--cached") && argv.includes("--shortstat")) {
        return "3 files changed, 10 insertions(+), 2 deletions(-)";
      }
      if (argv.includes("--stat")) {
        return [
          " src/a.ts   | 3 ++-",
          " src/new.ts | 2 ++",
          " 2 files changed, 4 insertions(+), 1 deletion(-)",
        ].join("\n");
      }
      if (argv.includes("--name-status")) {
        return ["M\tsrc/a.ts", "A\tsrc/new.ts"].join("\n");
      }
      if (argv.includes("src/large.ts")) {
        return largeGitDiffOutput();
      }
      return [
        "diff --git a/src/a.ts b/src/a.ts",
        "index 1111111..2222222 100644",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,4 +1,5 @@ export function configure() {",
        " export function configure() {",
        "-  const mode = 'sample';",
        "+  const mode = 'complete';",
        "   const marker = 736;",
        "+  const exact = true;",
        "   return mode;",
        "diff --git a/src/new.ts b/src/new.ts",
        "new file mode 100644",
        "index 0000000..3333333",
        "--- /dev/null",
        "+++ b/src/new.ts",
        "@@ -0,0 +1,2 @@",
        "+export const complete = true;",
        "+export const reducer = 'git.diff';",
      ].join("\n");
    case "log":
      return argv.some((argument) => argument.startsWith("--pretty=format:%h "))
        ? rtkGitLogOutput()
        : nativeGitLogOutput();
    case "show":
      if (argv.includes("--no-patch")) {
        return "1111111 Preserve complete context (1 day ago) <Falryn>";
      }
      if (argv.includes("--stat") && argv.includes("--pretty=format:")) {
        return gitDiffStatOutput();
      }
      if (argv.includes("--pretty=format:")) {
        return completeGitDiffOutput();
      }
      return `${nativeGitLogOutput().split("\n\ncommit ", 1)[0] ?? ""}\n\n${completeGitDiffOutput()}`;
    case "add":
      return "";
    case "branch":
      return argv.includes("-a") || argv.includes("--all")
        ? ["  feature/736", "* main", "  remotes/origin/main", "  remotes/origin/release/v1"].join(
            "\n",
          )
        : ["  feature/736", "* main"].join("\n");
    case "checkout":
      return "Switched to branch 'feature/736'";
    case "commit":
      return [
        "[feature 2222222] Preserve complete context",
        " 3 files changed, 10 insertions(+), 2 deletions(-)",
      ].join("\n");
    case "fetch":
      return ["From github.com:tyldra-org/falryn", "   1111111..2222222  main -> origin/main"].join(
        "\n",
      );
    case "push":
      return [
        "Enumerating objects: 3, done.",
        "Writing objects: 100% (3/3), done.",
        "To github.com:yogeshprasad098/falryn.git",
        "   1111111..2222222  feature -> feature",
      ].join("\n");
    case "pull":
      return [
        "Updating 1111111..2222222",
        "Fast-forward",
        " src/a.ts | 8 +++++---",
        " src/b.ts | 2 ++",
        " src/c.ts | 2 --",
        " 3 files changed, 10 insertions(+), 2 deletions(-)",
      ].join("\n");
    case "stash":
      return argv.includes("list")
        ? [
            "stash@{0}: On main: Preserve complete context",
            "stash@{1}: WIP on feature/736: Keep every useful fact",
          ].join("\n")
        : "Saved working directory and index state On main: Preserve complete context";
    case "worktree":
      return [
        `${process.env.FALRYN_HUSH_FIXTURE_CWD ?? process.cwd()} 1111111 [main]`,
        `${process.env.FALRYN_HUSH_FIXTURE_CWD ?? process.cwd()}-review 2222222 [review/736]`,
      ].join("\n");
    default:
      return "";
  }
}

function nativeGitLogOutput(): string {
  return [
    "commit 1111111111111111111111111111111111111111",
    "Author: Falryn <falryn@example.com>",
    "Date:   Sat Aug 23 12:00:00 2026 -0700",
    "",
    "    Preserve complete context",
    "",
    "    Keep every requested commit.",
    "",
    "commit 2222222222222222222222222222222222222222",
    "Author: Context Agent <context@example.com>",
    "Date:   Mon Aug 24 06:34:25 2026 -0700",
    "",
    "    Keep every message fact",
    "",
    "commit 3333333333333333333333333333333333333333",
    "Author: Review Agent <review@example.com>",
    "Date:   Mon Aug 24 07:00:00 2026 -0700",
    "",
    "    Keep the final commit",
  ].join("\n");
}

function rtkGitLogOutput(): string {
  return [
    "1111111 Preserve complete context (1 day ago) <Falryn>",
    "Keep every requested commit.",
    "---END---",
    "2222222 Keep every message fact (2 hours ago) <Context Agent>",
    "---END---",
    "3333333 Keep the final commit (1 hour ago) <Review Agent>",
    "---END---",
  ].join("\n");
}

function completeGitDiffOutput(): string {
  return [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1111111..2222222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,4 +1,5 @@ export function configure() {",
    " export function configure() {",
    "-  const mode = 'sample';",
    "+  const mode = 'complete';",
    "   const marker = 736;",
    "+  const exact = true;",
    "   return mode;",
    "diff --git a/src/new.ts b/src/new.ts",
    "new file mode 100644",
    "index 0000000..3333333",
    "--- /dev/null",
    "+++ b/src/new.ts",
    "@@ -0,0 +1,2 @@",
    "+export const complete = true;",
    "+export const reducer = 'git.show';",
  ].join("\n");
}

function gitDiffStatOutput(): string {
  return [
    " src/a.ts   | 3 ++-",
    " src/new.ts | 2 ++",
    " 2 files changed, 4 insertions(+), 1 deletion(-)",
  ].join("\n");
}

export function gitSubcommand(argv: readonly string[]): string {
  return argv.find((argument) => !argument.startsWith("-")) ?? "";
}

function largeGitDiffOutput(): string {
  const removed = Array.from({ length: 80 }, (_, index) => `-before-${index + 1}`);
  const added = Array.from({ length: 80 }, (_, index) => `+after-${index + 1}`);
  return [
    "diff --git a/src/large.ts b/src/large.ts",
    "index 1111111..2222222 100644",
    "--- a/src/large.ts",
    "+++ b/src/large.ts",
    "@@ -1,82 +1,82 @@ complete section",
    " context-before",
    ...removed,
    ...added,
    " context-after",
  ].join("\n");
}
