/** File, search, transform, and generic command rules. */

import { reduceBuild } from "../reducers/build/reduce.ts";
import { reduceCount } from "../reducers/count/reduce.ts";
import { reduceDiagnostic } from "../reducers/diagnostic/reduce.ts";
import { reduceGitDiff } from "../reducers/git/diff.ts";
import { reduceJson } from "../reducers/json/reduce.ts";
import { reduceListing } from "../reducers/listing/reduce.ts";
import { reduceLog } from "../reducers/log/reduce.ts";
import { reduceLs } from "../reducers/ls/reduce.ts";
import { reduceOperation } from "../reducers/operation/reduce.ts";
import { reduceRead } from "../reducers/plain-text.ts";
import { reduceSearch } from "../reducers/search/reduce.ts";
import { reduceTest } from "../reducers/test/reduce.ts";
import { reduceTransform } from "../reducers/transform/reduce.ts";
import { reduceTree } from "../reducers/tree/reduce.ts";
import { defineCommandRule } from "./contracts.ts";

export const FILE_RULES = [
  defineCommandRule(
    {
      reducerId: "files.ls",
      family: "listing",
      projection: "ls",
      executables: ["ls"],
      examples: ["ls", "ls -la", "ls -R workspace"],
    },
    reduceLs,
  ),
  defineCommandRule(
    {
      reducerId: "files.tree",
      family: "listing",
      projection: "tree",
      executables: ["tree"],
      examples: ["tree", "tree -L 3"],
    },
    reduceTree,
  ),
  defineCommandRule(
    {
      reducerId: "files.find",
      family: "listing",
      projection: "listing",
      executables: ["find"],
      examples: ["find . -name '*.ts'"],
    },
    reduceListing,
  ),
  defineCommandRule(
    {
      reducerId: "files.read",
      family: "listing",
      projection: "read",
      executables: ["cat", "head", "bat"],
      examples: ["cat README.md", "head -20 src/main.ts", "bat src/main.ts"],
    },
    reduceRead,
  ),
  defineCommandRule(
    {
      reducerId: "files.tail",
      family: "log",
      projection: "log",
      executables: ["tail"],
      examples: ["tail -n 20 app.log"],
    },
    reduceLog,
  ),
  defineCommandRule(
    {
      reducerId: "files.rg",
      family: "search",
      projection: "search",
      executables: ["rg", "ripgrep"],
      examples: ["rg 'TODO' src"],
    },
    reduceSearch,
  ),
  defineCommandRule(
    {
      reducerId: "files.grep",
      family: "search",
      projection: "search",
      executables: ["grep", "ag"],
      examples: ["grep -R TODO src"],
    },
    reduceSearch,
  ),
  defineCommandRule(
    {
      reducerId: "transform.sed",
      family: "data",
      projection: "transform",
      executables: ["sed"],
      examples: ["sed -n '1,40p' src/main.ts"],
    },
    reduceTransform,
  ),
  defineCommandRule(
    {
      reducerId: "files.diff",
      family: "listing",
      projection: "git-diff",
      executables: ["diff"],
      examples: ["diff before.ts after.ts"],
    },
    reduceGitDiff,
  ),
  defineCommandRule(
    {
      reducerId: "files.count",
      family: "data",
      projection: "count",
      executables: ["wc"],
      examples: ["wc -l src/main.ts"],
    },
    reduceCount,
  ),
  defineCommandRule(
    {
      reducerId: "data.json",
      family: "data",
      projection: "json",
      executables: ["json"],
      examples: ["json package.json"],
    },
    reduceJson,
  ),
  defineCommandRule(
    {
      reducerId: "transform.log",
      family: "log",
      projection: "log",
      executables: ["journalctl"],
      examples: ["journalctl -u falryn"],
    },
    reduceLog,
  ),
  defineCommandRule(
    {
      reducerId: "transform.summary",
      family: "build",
      projection: "operation",
      executables: ["err"],
      examples: ["err make"],
    },
    reduceOperation,
  ),
  defineCommandRule(
    {
      reducerId: "test.generic",
      family: "test",
      projection: "test",
      executables: ["test"],
      examples: ["test custom-runner"],
    },
    reduceTest,
  ),
  defineCommandRule(
    {
      reducerId: "format.generic",
      family: "lint",
      projection: "diagnostic",
      executables: ["format", "lint"],
      examples: ["format --check .", "lint src"],
    },
    reduceDiagnostic,
  ),
  defineCommandRule(
    {
      reducerId: "build.generic",
      family: "build",
      projection: "build",
      executables: ["build"],
      examples: ["build"],
    },
    reduceBuild,
  ),
] as const;
