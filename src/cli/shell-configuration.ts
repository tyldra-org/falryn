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
 * what the shell opens with. The other three — refused, published nowhere,
 * cancelled — report what was wrong on the diagnostic handle and hand back the
 * registry's declared defaults, which it documents as complete by construction.
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
import type { ConfigurationValues } from "../domain/index.ts";
import { configurationOverridesFor, type GlobalOptions } from "./options.ts";
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

/** Resolves this run's settings, reporting anything that made them unusable. */
export async function resolveShellConfiguration(
  globals: GlobalOptions,
  request: ShellConfigurationRequest,
): Promise<ConfigurationValues> {
  const { streams } = request;
  // Constructing the graph is cheap — roots resolved, a registry and a loader
  // built, a layout computed from paths. Every filesystem read happens inside
  // `load`. So the property being protected is not "construct nothing", it is
  // construct nothing on a run that declined to launch, and the caller holds
  // that by never reaching this.
  const { loader, registry, configurationRoot, workspaceRoot } = request.services(globals)();

  const outcome = await loader.load({
    configurationRoot,
    workspaceRoot,
    profile: globals.profile,
    overrides: configurationOverridesFor(globals),
  });

  if (outcome.kind === "published" || outcome.kind === "unchanged") {
    return outcome.record.values;
  }

  // `rejected` is the only one of the three that carries issues, and the only
  // one reachable on a first load. The other two say what happened by their
  // kind, which is all there is to say about them.
  const error =
    outcome.kind === "rejected"
      ? fromConfigurationIssues(outcome.issues, { operation: "load configuration" })
      : null;
  writeDiagnosticLine(
    streams,
    error === null
      ? `Configuration could not be loaded (${outcome.kind}); declared defaults are in effect.`
      : `${error.message} Declared defaults are in effect.`,
  );
  return registry.defaults();
}
