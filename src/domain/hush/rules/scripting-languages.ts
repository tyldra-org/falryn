/** Scripting-language package, test, diagnostic, and build rules. */

import {
  reduceBuild,
  reduceDiagnostic,
  reduceOperation,
  reducePackage,
  reduceTest,
} from "../reducers/entrypoints.ts";
import { defineCommandRule } from "./contracts.ts";

export const PYTHON_RULES = [
  defineCommandRule(
    {
      reducerId: "python.test",
      family: "test",
      projection: "test",
      executables: ["pytest"],
      examples: ["pytest", "python -m pytest"],
    },
    reduceTest,
  ),
  defineCommandRule(
    {
      reducerId: "python.diagnostic",
      family: "lint",
      projection: "diagnostic",
      executables: ["mypy", "ruff"],
      examples: ["mypy src", "python -m mypy src", "ruff check .", "ruff format --check ."],
    },
    reduceDiagnostic,
  ),
  defineCommandRule(
    {
      reducerId: "python.package",
      family: "package",
      projection: "package",
      executables: ["pip", "pip3", "uv", "poetry"],
      examples: [
        "pip list",
        "pip outdated",
        "pip install package",
        "pip show package",
        "uv pip install package",
        "uv run custom",
        "uv sync",
        "poetry install",
        "poetry lock",
        "poetry update",
      ],
    },
    reducePackage,
  ),
] as const;

export const ELIXIR_RULES = [
  defineCommandRule(
    {
      reducerId: "elixir.diagnostic",
      family: "lint",
      projection: "diagnostic",
      executables: ["mix"],
      examples: ["mix format"],
      matches: (tokens) => tokens[1] === "format",
    },
    reduceDiagnostic,
  ),
  defineCommandRule(
    {
      reducerId: "elixir.build",
      family: "build",
      projection: "build",
      executables: ["mix"],
      examples: ["mix compile"],
    },
    reduceBuild,
  ),
] as const;

export const PHP_RULES = [
  defineCommandRule(
    {
      reducerId: "php.test",
      family: "test",
      projection: "test",
      executables: ["phpunit", "pest", "paratest"],
      examples: ["phpunit", "vendor/bin/pest", "vendor/bin/paratest"],
    },
    reduceTest,
  ),
  defineCommandRule(
    {
      reducerId: "php.diagnostic",
      family: "lint",
      projection: "diagnostic",
      executables: ["phpstan", "ecs", "pint"],
      examples: ["phpstan analyse src", "ecs check src", "pint --test"],
    },
    reduceDiagnostic,
  ),
  defineCommandRule(
    {
      reducerId: "php.command",
      family: "build",
      projection: "operation",
      executables: ["php"],
      examples: ["php app.php", "php artisan about", "php -l app.php"],
    },
    reduceOperation,
  ),
] as const;

export const RUBY_RULES = [
  defineCommandRule(
    {
      reducerId: "ruby.test",
      family: "test",
      projection: "test",
      executables: ["rake", "rails", "rspec"],
      examples: ["rake test", "rails test", "bundle exec rspec"],
      matches: (tokens) => tokens[0] === "rspec" || tokens.includes("test"),
    },
    reduceTest,
  ),
  defineCommandRule(
    {
      reducerId: "ruby.diagnostic",
      family: "lint",
      projection: "diagnostic",
      executables: ["rubocop"],
      examples: ["bundle exec rubocop"],
    },
    reduceDiagnostic,
  ),
] as const;
