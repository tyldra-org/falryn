/** Command-aware package-manager routing for Hush projections. */

export const PACKAGE_EXECUTABLES = [
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "npx",
  "pnpx",
  "pip",
  "pip3",
  "uv",
  "poetry",
  "brew",
  "composer",
  "bundle",
] as const;

export type PackageExecutable = (typeof PACKAGE_EXECUTABLES)[number];
export type PackageAction = "install" | "list" | "outdated" | "show" | "run" | "other";

const PACKAGE_EXECUTABLE_SET = new Set<string>(PACKAGE_EXECUTABLES);
const INSTALL_ACTIONS = new Set([
  "add",
  "ci",
  "i",
  "install",
  "lock",
  "remove",
  "reinstall",
  "require",
  "rm",
  "sync",
  "uninstall",
  "up",
  "update",
  "upgrade",
]);
const LIST_ACTIONS = new Set(["list", "ls"]);
const RUN_ACTIONS = new Set(["run", "run-script"]);
const SHOW_ACTIONS = new Set(["info", "show"]);

export function packageExecutable(tokens: readonly string[]): PackageExecutable | null {
  const executable = tokens[0]?.split(/[\\/]/u).at(-1)?.toLowerCase() ?? "";
  return PACKAGE_EXECUTABLE_SET.has(executable) ? (executable as PackageExecutable) : null;
}

export function packageAction(tokens: readonly string[]): PackageAction {
  const executable = packageExecutable(tokens);
  if (executable === "npx" || executable === "pnpx" || executable === null) {
    return "other";
  }
  const arguments_ = tokens.slice(1).map((token) => token.toLowerCase());
  if (executable === "uv" && arguments_[0] === "run") {
    return "other";
  }
  if ((executable === "poetry" || executable === "composer") && arguments_[0] === "show") {
    return "list";
  }
  if ((executable === "poetry" || executable === "composer") && arguments_[0] === "list") {
    return "other";
  }
  if (arguments_.includes("outdated") || arguments_.includes("--outdated")) {
    return "outdated";
  }
  for (const token of arguments_) {
    const value = token.toLowerCase();
    if (INSTALL_ACTIONS.has(value)) {
      return "install";
    }
    if (LIST_ACTIONS.has(value)) {
      return "list";
    }
    if (SHOW_ACTIONS.has(value)) {
      return "show";
    }
    if (RUN_ACTIONS.has(value)) {
      return "run";
    }
  }
  return executable === "yarn" ? "run" : "other";
}

export function hasPackageOutputOverride(tokens: readonly string[]): boolean {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]?.toLowerCase() ?? "";
    if (
      token === "--json" ||
      token.startsWith("--json=") ||
      token === "--ndjson" ||
      token === "--parseable" ||
      token === "--format" ||
      token.startsWith("--format=") ||
      token === "--silent" ||
      token === "--quiet" ||
      token === "-q" ||
      token === "--help" ||
      token === "-h" ||
      token === "--version" ||
      token === "-v"
    ) {
      return true;
    }
    if (token === "--reporter") {
      const reporter = tokens[index + 1]?.toLowerCase();
      if (reporter === "ndjson" || reporter === "silent") {
        return true;
      }
    }
    if (token.startsWith("--reporter=") && /(?:ndjson|silent)$/u.test(token)) {
      return true;
    }
  }
  return false;
}
