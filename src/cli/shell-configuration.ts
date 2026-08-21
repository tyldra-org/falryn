/**
 * The settings an interactive run opens with.
 *
 * `src/cli/dispatch.ts` builds no service graph for the no-argument invocation,
 * deliberately: the launch decision is taken from observed facts before anything
 * service-shaped or OpenTUI-shaped is loaded, so a run that was never going to
 * open a shell pays nothing to find out. That property is worth keeping, and
 * this module is the other half of it — once the decision *is* to launch, the
 * settings are read here and nowhere earlier.
 *
 * It is a module rather than a function inside dispatch for one reason: the
 * rules below are worth checking directly. A test that had to open a shell to
 * find out what a bad settings file does would be testing a renderer to learn
 * about a loader.
 *
 * ## One rule for every outcome that is not a record
 *
 * `load` answers five ways. Two carry a usable generation, and its `values` are
 * what the shell opens with. The other three report on the diagnostic handle and
 * hand back the registry's declared defaults, which it documents as complete by
 * construction — one rule, but three sentences, because only one of the three
 * means the user's configuration was bad. See {@link whyDefaults}.
 *
 * Refusing to open a shell over a settings file would be the worse failure. A
 * user who mistyped a key gets an interface that works and a line saying what
 * was ignored, which is the same shape an unrecognized `FALRYN_TUI` already
 * takes: reported rather than obeyed, and never silently dropped.
 *
 * The message comes from `fromConfigurationIssues`, so what a user reads about a
 * bad key is the one vocabulary the `config` commands already speak — bounded,
 * and carrying no rejected value, because the issues themselves never do.
 *
 * ## What it does not decide
 *
 * Precedence. `configurationOverridesFor` already maps `--verbose` and
 * `--quiet` onto the declared key they override, and the loader already owns
 * layering. This passes that same map and the same profile, so `falryn
 * --verbose` means one thing whether it opens a shell or runs a command. A
 * second mapping here would be a second precedence rule.
 */

import { fromConfigurationIssues } from "../application/index.ts";
import {
  assertNever,
  type ConfigurationGeneration,
  type ConfigurationLoadOutcome,
  type ConfigurationValues,
} from "../domain/index.ts";
import type { GlobalOptions } from "./options.ts";
import {
  loadProductConfiguration,
  productConfigurationLoadRequest,
} from "./product-configuration.ts";
import type { ServiceProvider } from "./services.ts";
import { type CliStreams, writeDiagnosticLine } from "./streams.ts";

export type ShellConfigurationRequest = {
  readonly streams: CliStreams;
  /**
   * The same seam a command's services come through.
   *
   * Taken as the already-resolved provider rather than as the options bag, so
   * this module has no opinion about where a graph comes from — and a test
   * injects one rather than reaching a developer's real roots.
   */
  readonly services: (options: GlobalOptions) => ServiceProvider;
};

export type ShellBootstrapConfiguration = {
  readonly values: ConfigurationValues;
  readonly generation: ConfigurationGeneration;
};

/**
 * Resolves settings and the configuration generation product bootstrap should
 * correlate on, reporting anything that made the load unusable.
 */
export async function resolveShellBootstrapConfiguration(
  globals: GlobalOptions,
  request: ShellConfigurationRequest,
): Promise<ShellBootstrapConfiguration> {
  const { streams } = request;
  const graph = request.services(globals)();
  const loaded = await loadProductConfiguration(graph, productConfigurationLoadRequest(globals));

  if (loaded.outcome.kind === "published" || loaded.outcome.kind === "unchanged") {
    return { values: loaded.values, generation: loaded.generation };
  }

  writeDiagnosticLine(streams, whyDefaults(loaded.outcome));
  return { values: loaded.values, generation: loaded.generation };
}

/** Resolves this run's settings, reporting anything that made them unusable. */
export async function resolveShellConfiguration(
  globals: GlobalOptions,
  request: ShellConfigurationRequest,
): Promise<ConfigurationValues> {
  const bootstrap = await resolveShellBootstrapConfiguration(globals, request);
  return bootstrap.values;
}

/** What every answer ends with, because the user's next question is what is in effect. */
const IN_EFFECT = "Declared defaults are in effect.";

/**
 * Why this run is opening with defaults, in words the outcome earns.
 *
 * Three outcomes, three sentences, and the distinction is not pedantry. Only
 * one of them means the configuration was bad:
 *
 * - `rejected` — composition failed. The user's file is the problem, and the
 *   sentence comes from `fromConfigurationIssues` so it is the one `config
 *   show` would have printed for the same issue.
 * - `publish-failed` — composition *succeeded* and the generation could not be
 *   recorded. Telling this user their configuration could not be loaded would
 *   be false: it loaded, it validated, and something else went wrong. The
 *   `code` is the only detail the outcome carries and dropping it would leave
 *   nothing to act on.
 * - `cancelled` — the caller stopped. Nothing was wrong with anything.
 *
 * All three are reachable on a first load, `publish-failed` included: the
 * loader's `unchanged` branch is guarded on there being a previous generation,
 * so a first load falls through to appending the generation event, and an
 * unwritable or full state root fails there. An earlier version of this module
 * claimed `rejected` was the only one — which made the other two share a
 * sentence that was wrong for both.
 */
function whyDefaults(
  outcome: Extract<ConfigurationLoadOutcome, { kind: "rejected" | "publish-failed" | "cancelled" }>,
): string {
  switch (outcome.kind) {
    case "rejected": {
      const error = fromConfigurationIssues(outcome.issues, { operation: "load configuration" });
      return error === null
        ? `Configuration was refused. ${IN_EFFECT}`
        : `${error.message} ${IN_EFFECT}`;
    }
    case "publish-failed":
      return `Configuration was valid but could not be recorded (${outcome.code}). ${IN_EFFECT}`;
    case "cancelled":
      return `Loading configuration was cancelled. ${IN_EFFECT}`;
    default:
      return assertNever(outcome, "an unhandled configuration load outcome");
  }
}
