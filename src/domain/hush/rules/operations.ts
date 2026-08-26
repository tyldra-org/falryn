/** Package, data, network, system, and general operation rules. */

import {
  reduceBuild,
  reduceCurl,
  reduceDiagnostic,
  reduceNetwork,
  reduceOperation,
  reducePackage,
  reduceStructured,
  reduceTable,
  reduceWget,
} from "../reducers/entrypoints.ts";
import { defineCommandRule } from "./contracts.ts";

export const PACKAGE_OPERATION_RULES = [
  defineCommandRule(
    {
      reducerId: "package.manager",
      family: "package",
      projection: "package",
      executables: ["brew", "composer", "bundle"],
      examples: [
        "brew install bun",
        "brew upgrade bun",
        "composer install",
        "composer update",
        "composer require package",
        "bundle install",
        "bundle update",
      ],
    },
    reducePackage,
  ),
  defineCommandRule(
    {
      reducerId: "task.build",
      family: "build",
      projection: "build",
      executables: ["just", "mise", "task", "make"],
      examples: ["just build", "mise run test", "task build", "make build"],
    },
    reduceBuild,
  ),
  defineCommandRule(
    {
      reducerId: "precommit.diagnostic",
      family: "lint",
      projection: "diagnostic",
      executables: ["pre-commit"],
      examples: ["pre-commit run --all-files"],
    },
    reduceDiagnostic,
  ),
] as const;

export const DATA_AND_NETWORK_RULES = [
  defineCommandRule(
    {
      reducerId: "data.command",
      family: "data",
      projection: "structured",
      executables: ["psql", "jq", "sqlite3"],
      examples: ["psql -c 'select 1'", "jq . package.json", "sqlite3 db.sqlite '.tables'"],
    },
    reduceStructured,
  ),
  defineCommandRule(
    {
      reducerId: "network.curl",
      family: "http",
      projection: "curl",
      executables: ["curl"],
      examples: ["curl https://example.com"],
    },
    reduceCurl,
  ),
  defineCommandRule(
    {
      reducerId: "network.wget",
      family: "http",
      projection: "wget",
      executables: ["wget"],
      examples: ["wget https://example.com/file"],
    },
    reduceWget,
  ),
  defineCommandRule(
    {
      reducerId: "network.command",
      family: "http",
      projection: "network",
      executables: ["ping", "rsync", "ssh"],
      examples: ["ping example.com", "rsync source target", "ssh host command"],
    },
    reduceNetwork,
  ),
] as const;

export const SYSTEM_OPERATION_RULES = [
  defineCommandRule(
    {
      reducerId: "system.table",
      family: "data",
      projection: "table",
      executables: ["df", "du", "ps", "stat", "systemctl"],
      examples: ["df -h", "du -sh .", "ps aux", "stat file", "systemctl status falryn"],
    },
    reduceTable,
  ),
  defineCommandRule(
    {
      reducerId: "diagnostic.command",
      family: "lint",
      projection: "diagnostic",
      executables: ["hadolint", "markdownlint", "shellcheck", "yamllint"],
      examples: ["hadolint Dockerfile", "markdownlint docs", "shellcheck script.sh", "yamllint ."],
    },
    reduceDiagnostic,
  ),
  defineCommandRule(
    {
      reducerId: "operation.command",
      family: "build",
      projection: "operation",
      executables: ["shopify", "ollama", "java"],
      examples: [
        "shopify theme push",
        "shopify theme pull",
        "ollama run model",
        "java -jar app.jar",
      ],
    },
    reduceOperation,
  ),
] as const;
