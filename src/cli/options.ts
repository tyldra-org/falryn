/**
 * The global options, and what each one actually overrides.
 *
 * Only options with something real behind them today. An option parsed into a
 * value nothing reads is a promise the binary cannot keep, so `--set`, a
 * provider selector, and a model role are absent until the capability that
 * would honour them exists.
 *
 * Three of these are *configuration* overrides and the rest are not, and the
 * difference is load-bearing:
 *
 * - `--verbose` and `--quiet` resolve to `diagnostics.level`, a declared key,
 *   and reach configuration through `readOverrideLayer` — the same
 *   `cli-override` layer and the same `user → project → profile → environment →
 *   cli` precedence #8 already implements and tests. This module writes no
 *   precedence rule; it produces a `path → string` map and hands it over.
 * - `--workspace` and `--profile` are *inputs to loading*, not overrides of a
 *   loaded value. They select which sources are discovered, so they travel to
 *   the loader's request rather than to the override layer.
 * - `--format`, `--color`, `--non-interactive`, and `--timeout` are facts about
 *   this invocation. No declared key describes them, and inventing one so the
 *   table looks uniform would put a setting into a schema nothing reads.
 */

import type { ColorLevel } from "../domain/index.ts";

/** The four output contracts `reference/CLI.md` names. #18 and #19 render them. */
export const OUTPUT_FORMATS = ["human", "json", "jsonl", "quiet"] as const;

export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/** What `--color` may say. `auto` defers to the capability fact #20 computes. */
export const COLOR_CHOICES = ["auto", "always", "never"] as const;

export type ColorChoice = (typeof COLOR_CHOICES)[number];

/**
 * The declared key `--verbose` and `--quiet` resolve to.
 *
 * Named once, here, so the mapping is checkable against `src/config/keys.ts`
 * rather than spelled at a call site.
 */
export const DIAGNOSTIC_LEVEL_KEY = "diagnostics.level";

/** Longest `--timeout` this build accepts, in milliseconds. */
export const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * What a parsed invocation asks for, before any service exists.
 *
 * Every field is present and resolved rather than optional, the convention
 * `src/domain/error.ts` states: a caller reading this never has to distinguish
 * "absent" from "not applicable".
 */
export type GlobalOptions = {
  readonly format: OutputFormat;
  readonly color: ColorChoice;
  readonly quiet: boolean;
  readonly verbose: boolean;
  readonly nonInteractive: boolean;
  /** An explicit workspace root or saved layout name, or `null` for cwd. */
  readonly workspace: string | null;
  /** Extra roots for this invocation only (`--add-dir`, repeatable). */
  readonly addDirs: readonly string[];
  /** A configuration profile name, or `null` for none. */
  readonly profile: string | null;
  /** A total deadline in milliseconds, or `null` for none. */
  readonly timeoutMs: number | null;
  readonly help: boolean;
  readonly version: boolean;
};

/**
 * The configuration overrides these options request.
 *
 * A `path → raw string` map, which is exactly what `readOverrideLayer` takes.
 * It is deliberately not a resolved value: coercion, range checking, and the
 * `unknown-key` verdict all belong to the registry, and doing any of them here
 * would be a second validation rule for a key that already declares its own.
 */
export function configurationOverridesFor(
  options: GlobalOptions,
): Readonly<Record<string, string>> {
  // `--quiet` and `--verbose` are rejected together before dispatch, so at most
  // one of these branches can be taken.
  if (options.verbose) {
    return { [DIAGNOSTIC_LEVEL_KEY]: "debug" };
  }
  if (options.quiet) {
    return { [DIAGNOSTIC_LEVEL_KEY]: "error" };
  }
  return {};
}

/**
 * The colour a run should use, given what was asked and what is true.
 *
 * `--color` overrides the capability fact rather than replacing the
 * computation: `auto` returns the derived level untouched, `never` refuses, and
 * `always` grants the depth the handle would have had if it were a terminal.
 */
export function resolveColor(choice: ColorChoice, derived: ColorLevel): ColorLevel {
  switch (choice) {
    case "auto":
      return derived;
    case "never":
      return "none";
    case "always":
      // A forced request against a handle that advertises nothing still gets
      // the depth every colour terminal has, matching `FORCE_COLOR` with no
      // depth. It never invents a depth the terminal claimed not to support.
      return derived === "none" ? "basic" : derived;
  }
}

/**
 * A machine format silences human decoration entirely.
 *
 * Not a preference: ANSI in a captured JSON stream corrupts it, and
 * `guides/HEADLESS-AND-CI.md` states machine modes never contain it.
 */
export function allowsColor(format: OutputFormat): boolean {
  return format === "human";
}
