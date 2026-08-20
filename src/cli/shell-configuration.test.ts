/**
 * What an interactive run opens with, and what it does when it cannot.
 *
 * The rules are checked here rather than through a rendered shell, because a
 * test that had to open an interface to find out what a bad settings file does
 * would be testing a renderer to learn about a loader. What the shell does with
 * the values is its own concern; there is no interface key yet, so there is
 * nothing for it to do with them but hold them.
 *
 * Every check runs over an in-memory filesystem and a static environment, so
 * none of them can read the developer's real roots — which is also what makes
 * "a declared key's value arrives" a statement about layering rather than about
 * whatever happens to be in `~`.
 */

import { describe, expect, test } from "bun:test";
import { CONFIGURATION_FILE_NAME, PROJECT_CONFIGURATION_DIRECTORY } from "../config/index.ts";
import type { ConfigurationLoadOutcome } from "../domain/index.ts";
import {
  configurationKeyPath,
  createInMemoryFileSystem,
  createStaticEnvironment,
  type FileSystemPort,
  localPath,
} from "../domain/index.ts";
import type { GlobalOptions } from "./options.ts";
import { createServiceProvider, type ServiceProvider } from "./services.ts";
import { resolveShellConfiguration } from "./shell-configuration.ts";
import { createRecordingCliStreams } from "./streams.ts";

/** The version a document must declare before any of its keys are read. */
const SCHEMA_VERSION = 1;

/** A key that is declared, relocatable, and reads an environment variable. */
const STATE_ROOT = configurationKeyPath("data.roots.state");
const STATE_ROOT_VARIABLE = "FALRYN_STATE_DIR";

const GLOBALS: GlobalOptions = {
  color: "auto",
  format: "human",
  nonInteractive: false,
  profile: null,
  quiet: false,
  timeoutMs: null,
  verbose: false,
  workspace: null,
  addDirs: [],
  help: false,
  version: false,
};

function provider(
  fileSystem: FileSystemPort,
  variables: Readonly<Record<string, string>> = {},
): (options: GlobalOptions) => ServiceProvider {
  return (globals) =>
    createServiceProvider(globals, {
      home: localPath("/home/tester"),
      platform: "darwin",
      environment: createStaticEnvironment(variables),
      currentDirectory: localPath("/workspace"),
      fileSystem,
    });
}

describe("the settings an interactive run opens with", () => {
  test("are the declared defaults when nothing is configured", async () => {
    const streams = createRecordingCliStreams();
    const values = await resolveShellConfiguration(GLOBALS, {
      streams,
      services: provider(createInMemoryFileSystem()),
    });

    // Complete by construction, which is what makes it a usable answer rather
    // than an empty one: every declared key is present at its default.
    expect(Object.keys(values).length).toBeGreaterThan(0);
    expect(values[STATE_ROOT]).toBeDefined();
    // Nothing was wrong, so nothing was said.
    expect(streams.diagnosticWrites()).toEqual([]);
  });

  test("carry a declared key's value from the environment layer", async () => {
    // The layer `readEnvironmentLayer` already defines, reached through the
    // launch path rather than through a command. A key declaring an
    // `environmentVariable` is settable without editing a file, and this is the
    // check that says so from the interactive side.
    const streams = createRecordingCliStreams();
    const values = await resolveShellConfiguration(GLOBALS, {
      streams,
      services: provider(createInMemoryFileSystem(), {
        [STATE_ROOT_VARIABLE]: "/tmp/from-the-environment",
      }),
    });

    expect(values[STATE_ROOT]).toBe("/tmp/from-the-environment");
    expect(streams.diagnosticWrites()).toEqual([]);
  });

  test("carry a declared key's value from a file layer", async () => {
    // The *user* file, not the project one, and that is the declaration's rule
    // rather than a convenience: `data.roots.state` declares scopes `user`,
    // `environment`, and `cli`, because a project checkout must not be able to
    // move where this machine keeps its data merely by being opened. Writing it
    // to the project layer is refused, which is a check `src/config` already
    // owns.
    const fileSystem = createInMemoryFileSystem();
    const services = provider(fileSystem);
    fileSystem.put(`${services(GLOBALS)().configurationRoot}/${CONFIGURATION_FILE_NAME}`, {
      kind: "file",
      text: JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        data: { roots: { state: "/tmp/from-the-file" } },
      }),
    });

    const streams = createRecordingCliStreams();
    const values = await resolveShellConfiguration(GLOBALS, { streams, services });

    expect(values[STATE_ROOT]).toBe("/tmp/from-the-file");
    expect(streams.diagnosticWrites()).toEqual([]);
  });
});

/**
 * A real graph with the loader replaced, for the outcomes a filesystem cannot
 * produce on demand.
 *
 * The registry, its defaults, and the roots stay real — only the answer changes
 * — so what is exercised is this module's rule rather than a mock of it.
 * Making a generation event append actually fail belongs to the loader's own
 * checks; what belongs here is what an interactive run does when it is told one
 * did.
 */
function loaderAnswering(
  outcome: ConfigurationLoadOutcome,
): (options: GlobalOptions) => ServiceProvider {
  const real = provider(createInMemoryFileSystem());
  return (globals) => {
    const services = real(globals);
    return () => ({
      ...services(),
      loader: { load: async () => outcome, current: () => null },
    });
  };
}

describe("settings that cannot be used", () => {
  test("are reported on the diagnostic handle and replaced by the defaults", async () => {
    // The rule the whole module exists for. A shell that refused to open over a
    // settings file would be a worse failure than one that opens with declared
    // defaults and says why — and `rejected` with nothing retained is the only
    // one of these reachable on a first load, which is why it is the case here.
    const fileSystem = createInMemoryFileSystem();
    fileSystem.put(`/workspace/${PROJECT_CONFIGURATION_DIRECTORY}/${CONFIGURATION_FILE_NAME}`, {
      kind: "file",
      text: JSON.stringify({ schemaVersion: SCHEMA_VERSION, data: { roots: { state: 42 } } }),
    });

    const streams = createRecordingCliStreams();
    const values = await resolveShellConfiguration(GLOBALS, {
      streams,
      services: provider(fileSystem),
    });

    // It said something.
    const said = streams.diagnosticWrites().join("");
    expect(said).not.toBe("");
    expect(said).toContain("defaults are in effect");
    // And it answered with something usable rather than nothing.
    expect(values[STATE_ROOT]).toBeDefined();
    expect(values[STATE_ROOT]).not.toBe(42);
    // The rejected value never reaches the diagnostic, because no issue carries
    // one. A settings file is not a place a secret should leak out of.
    expect(said).not.toContain("42");
  });

  test("say a valid configuration was not recorded, rather than that it failed to load", async () => {
    // `publish-failed` means composition *succeeded* and the generation could
    // not be recorded — an unwritable or full state root, not a bad file. It is
    // reachable on a first load: the loader's `unchanged` branch is guarded on
    // there being a previous generation, so a first load falls through to the
    // append. An earlier version of this module claimed only `rejected` could
    // happen there, and gave this path a sentence that told a user with a
    // perfectly good settings file that it could not be loaded.
    const streams = createRecordingCliStreams();
    const values = await resolveShellConfiguration(GLOBALS, {
      streams,
      services: loaderAnswering({
        kind: "publish-failed",
        code: "state-root-full",
        retained: null,
      }),
    });

    const said = streams.diagnosticWrites().join("");
    expect(said).toContain("could not be recorded");
    expect(said).not.toContain("could not be loaded");
    // The one detail the outcome carries, which is the only thing a user can
    // act on. Dropping it would leave the sentence true and useless.
    expect(said).toContain("state-root-full");
    expect(said).toContain("defaults are in effect");
    expect(values[STATE_ROOT]).toBeDefined();
  });

  test("say a cancelled load was cancelled, rather than that anything was wrong", async () => {
    const streams = createRecordingCliStreams();
    const values = await resolveShellConfiguration(GLOBALS, {
      streams,
      services: loaderAnswering({ kind: "cancelled" }),
    });

    const said = streams.diagnosticWrites().join("");
    expect(said).toContain("cancelled");
    expect(said).not.toContain("refused");
    // The discriminator, and it had to be measured rather than assumed: the
    // sentence this replaced named every outcome by kind — "Configuration could
    // not be loaded (cancelled)" — so asserting only that the word `cancelled`
    // appears passes against the message being corrected. A stopped load is not
    // a failed one, and that is the whole difference.
    expect(said).not.toContain("could not be loaded");
    expect(said).toContain("defaults are in effect");
    expect(values[STATE_ROOT]).toBeDefined();
  });

  test("say what was wrong in the vocabulary the config commands already use", async () => {
    const fileSystem = createInMemoryFileSystem();
    fileSystem.put(`/workspace/${PROJECT_CONFIGURATION_DIRECTORY}/${CONFIGURATION_FILE_NAME}`, {
      kind: "file",
      text: JSON.stringify({ schemaVersion: SCHEMA_VERSION, nope: { unknown: true } }),
    });

    const streams = createRecordingCliStreams();
    await resolveShellConfiguration(GLOBALS, { streams, services: provider(fileSystem) });

    // `fromConfigurationIssues` owns this sentence, so a user reads one
    // vocabulary whether they hit the problem through `config show` or by
    // opening the shell.
    expect(streams.diagnosticWrites().join("")).toContain("configuration key is not recognized");
  });
});
