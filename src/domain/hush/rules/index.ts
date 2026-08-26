/** Ordered Hush command rules and executable lookup. */

import { reduceCompound } from "../reducers/compound/reduce.ts";
import { reduceGitDiff } from "../reducers/git/diff.ts";
import { reduceGitLog } from "../reducers/git/log/reduce.ts";
import { reduceOperation } from "../reducers/operation/reduce.ts";
import { reduceSearch } from "../reducers/search/reduce.ts";
import {
  APPLE_AND_NATIVE_RULES,
  DOTNET_RULES,
  GO_RULES,
  JVM_RULES,
  RUST_RULES,
} from "./compiled-languages.ts";
import { CONTAINER_RULES } from "./containers.ts";
import type { HushCommandRule, HushReductionRule } from "./contracts.ts";
import { FILE_RULES } from "./files.ts";
import { FORGE_RULES, JIRA_RULES } from "./forge.ts";
import { CLOUD_RULES, INFRASTRUCTURE_RULES } from "./infrastructure.ts";
import { JAVASCRIPT_RULES } from "./javascript.ts";
import {
  DATA_AND_NETWORK_RULES,
  PACKAGE_OPERATION_RULES,
  SYSTEM_OPERATION_RULES,
} from "./operations.ts";
import { ELIXIR_RULES, PHP_RULES, PYTHON_RULES, RUBY_RULES } from "./scripting-languages.ts";
import { GIT_RULES, JUJUTSU_RULES } from "./version-control.ts";

export type {
  HushCommandClassification,
  HushCommandMatcher,
  HushCommandMatchKind,
  HushCommandRule,
  HushProjectionKind,
  HushReductionRule,
} from "./contracts.ts";
export { HUSH_PROJECTION_KINDS } from "./contracts.ts";

export const HUSH_COMMAND_RULES = [
  ...FILE_RULES,
  ...GIT_RULES,
  ...FORGE_RULES,
  ...JUJUTSU_RULES,
  ...JIRA_RULES,
  ...JAVASCRIPT_RULES,
  ...RUST_RULES,
  ...PYTHON_RULES,
  ...GO_RULES,
  ...JVM_RULES,
  ...DOTNET_RULES,
  ...APPLE_AND_NATIVE_RULES,
  ...ELIXIR_RULES,
  ...PHP_RULES,
  ...RUBY_RULES,
  ...CONTAINER_RULES,
  ...PACKAGE_OPERATION_RULES,
  ...CLOUD_RULES,
  ...DATA_AND_NETWORK_RULES,
  ...INFRASTRUCTURE_RULES,
  ...SYSTEM_OPERATION_RULES,
] as const satisfies readonly HushCommandRule[];

export type HushCommandReducerId = (typeof HUSH_COMMAND_RULES)[number]["reducerId"];

export const GENERIC_RULE: HushReductionRule = {
  family: "generic",
  reducerId: "generic",
  projection: "operation",
  reduce: reduceOperation,
};

export const SHELL_COMPOUND_RULE: HushReductionRule = {
  family: "generic",
  reducerId: "shell.compound",
  projection: "compound",
  reduce: reduceCompound,
};

export const OUTPUT_SEARCH_RULE: HushReductionRule = {
  family: "search",
  reducerId: "files.search",
  projection: "search",
  reduce: reduceSearch,
};

export const OUTPUT_GIT_LOG_RULE: HushReductionRule = {
  family: "git",
  reducerId: "git.log",
  projection: "git-log",
  reduce: reduceGitLog,
};

export const OUTPUT_GIT_DIFF_RULE: HushReductionRule = {
  family: "git",
  reducerId: "git.diff",
  projection: "git-diff",
  reduce: reduceGitDiff,
};

const RULES_BY_EXECUTABLE = commandIndex(HUSH_COMMAND_RULES);

export function matchHushCommand(tokens: readonly string[]): HushCommandRule | null {
  const executable = tokens[0];
  if (executable === undefined) {
    return null;
  }
  const rules = RULES_BY_EXECUTABLE.get(executable);
  if (rules === undefined) {
    return null;
  }
  for (const rule of rules) {
    if (rule.matches?.(tokens) ?? true) {
      return rule;
    }
  }
  return null;
}

function commandIndex(
  rules: readonly HushCommandRule[],
): ReadonlyMap<string, readonly HushCommandRule[]> {
  const mutable = new Map<string, HushCommandRule[]>();
  for (const rule of rules) {
    for (const executable of rule.executables) {
      const entries = mutable.get(executable) ?? [];
      entries.push(rule);
      mutable.set(executable, entries);
    }
  }
  return mutable;
}
