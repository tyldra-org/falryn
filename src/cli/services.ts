/**
 * What a command may reach, and when it is allowed to reach it.
 *
 * Commands receive a `ServiceProvider` — a function — rather than the services
 * themselves. That is the whole design: `reference/CLI.md` requires help and
 * version to initialize no provider, open no database, scan no workspace, and
 * start no integration, and the only way to *prove* that is to make
 * construction observable. `--help` never calls the provider, and
 * `src/cli/help-does-no-work.test.ts` runs it against a provider that throws.
 *
 * Nothing here reads a file, opens a database, or runs a process at
 * construction time either. The provider builds ports; a command decides what
 * to do with them.
 */

import { createRuntimeRedactor, DIAGNOSTICS_OWNERSHIP } from "../application/index.ts";
import {
  CONFIGURATION_OWNERSHIP,
  type ConfigurationLoader,
  createConfigurationLoader,
  createConfigurationRegistry,
  V0_1_CONFIGURATION_KEYS,
  V0_1_CROSS_FIELD_RULES,
} from "../config/index.ts";
import {
  ARTIFACTS_OWNERSHIP,
  CREDENTIAL_REFERENCE_OWNERSHIP,
  createLocalDataService,
  EXPORTS_OWNERSHIP,
  FALLBACK_HOME,
  rootChild,
  SQLITE_STATE_OWNERSHIP,
  TEMPORARY_INGEST_OWNERSHIP,
} from "../data/index.ts";
import {
  type ClockPort,
  type ConfigurationRegistryPort,
  createInMemoryEventStore,
  createSystemClock,
  type EnvironmentPort,
  type EventStorePort,
  type FileSystemPort,
  type LocalDataPlatform,
  type LocalPath,
  type LocalPathError,
  type OwnershipRegistration,
  parseLocalPath,
  type Result,
  resolveLocalPath,
  sessionId,
  streamId,
  traceId,
  workspaceId,
} from "../domain/index.ts";
import {
  createHostEnvironment,
  createHostFileSystem,
  hostHome,
  hostPlatform,
} from "../integrations/index.ts";
import type { GlobalOptions } from "./options.ts";

/**
 * The stream every event this process appends belongs to.
 *
 * Named here rather than at the append site so the machine projections can read
 * back what the run produced. One stream because one invocation is one run; a
 * session-scoped stream arrives with the capability that produces sessions.
 */
export const CLI_EVENT_STREAM = "configuration";

export type Services = {
  readonly fileSystem: FileSystemPort;
  readonly environment: EnvironmentPort;
  readonly clock: ClockPort;
  /**
   * Where this run's events were appended.
   *
   * In memory, and exposed so the JSON Lines projection can read the lifecycle
   * back. Inspecting settings still writes nothing durable — that is the
   * property the in-memory store exists for, and it is unchanged by reading it.
   */
  readonly eventStore: EventStorePort;
  readonly localData: ReturnType<typeof createLocalDataService>;
  /** A complete ownership view used only by the destructive data commands. */
  readonly removalData: ReturnType<typeof createLocalDataService>;
  readonly registry: ConfigurationRegistryPort;
  readonly loader: ConfigurationLoader;
  readonly configurationRoot: LocalPath;
  /** The explicit `--workspace`, or the current directory. */
  readonly workspaceRoot: LocalPath | null;
};

/**
 * Builds the services, at most once.
 *
 * A function rather than a value so a command that needs nothing constructs
 * nothing. Memoized so two commands in one process share one service graph
 * rather than opening a second of everything.
 */
export type ServiceProvider = () => Services;

export type HostServiceOptions = {
  /** Supplied by tests so a run never touches the developer's real roots. */
  readonly environment?: EnvironmentPort;
  readonly fileSystem?: FileSystemPort;
  readonly platform?: LocalDataPlatform;
  readonly home?: LocalPath;
  readonly clock?: ClockPort;
  /** The directory a relative `--workspace` resolves against. */
  readonly currentDirectory?: LocalPath;
};

/** Every v0.1 owner whose local-data bytes can be named by the CLI surface. */
const REMOVAL_OWNERSHIPS: readonly OwnershipRegistration[] = [
  CONFIGURATION_OWNERSHIP,
  CREDENTIAL_REFERENCE_OWNERSHIP,
  SQLITE_STATE_OWNERSHIP,
  ARTIFACTS_OWNERSHIP,
  DIAGNOSTICS_OWNERSHIP,
  TEMPORARY_INGEST_OWNERSHIP,
  EXPORTS_OWNERSHIP,
];

export function createServiceProvider(
  options: GlobalOptions,
  overrides: HostServiceOptions = {},
): ServiceProvider {
  let built: Services | null = null;

  return (): Services => {
    const existing = built;
    if (existing !== null) {
      return existing;
    }

    const environment = overrides.environment ?? createHostEnvironment();
    const fileSystem = overrides.fileSystem ?? createHostFileSystem();
    const clock = overrides.clock ?? createSystemClock();
    const home = overrides.home ?? hostHome() ?? FALLBACK_HOME;

    const localData = createLocalDataService({
      fileSystem,
      environment,
      platform: overrides.platform ?? hostPlatform(),
      home,
    });
    const removalData = createLocalDataService({
      fileSystem,
      environment,
      platform: overrides.platform ?? hostPlatform(),
      home,
    });
    for (const ownership of REMOVAL_OWNERSHIPS) {
      const registered = removalData.register(ownership);
      if (!registered.ok) {
        throw new Error(
          `Built-in removal ownership registration failed: ${registered.error.code}.`,
        );
      }
    }

    const registry = createConfigurationRegistry({
      declarations: V0_1_CONFIGURATION_KEYS,
      crossFieldRules: V0_1_CROSS_FIELD_RULES,
      redactor: createRuntimeRedactor(),
    });

    const eventStore = createInMemoryEventStore();
    const services: Services = {
      fileSystem,
      environment,
      clock,
      eventStore,
      localData,
      removalData,
      registry,
      loader: createConfigurationLoader({
        registry,
        declarations: V0_1_CONFIGURATION_KEYS,
        fileSystem,
        environment,
        // Injected, never reimplemented. A second redaction rule in the CLI
        // would be a second answer to what a secret looks like.
        redactor: createRuntimeRedactor(),
        clock,
        // In memory on purpose: `config show` is a read, and appending a
        // durable generation event because someone inspected their settings
        // would write to a user's database for a question.
        eventStore,
        // Synthetic identities for a read that belongs to no session. The
        // loader's event never leaves this process, so these correlate the
        // inspection rather than naming durable work.
        correlation: {
          workspaceId: workspaceId.from("cli"),
          sessionId: sessionId.from("cli"),
          traceId: traceId.from("cli"),
        },
        streamId: streamId.from(CLI_EVENT_STREAM),
      }),
      configurationRoot: rootChild(localData.layout, "configuration") ?? home,
      workspaceRoot: workspaceRootFrom(options, overrides),
    };
    built = services;
    return services;
  };
}

/**
 * The workspace this invocation operates on.
 *
 * An explicit `--workspace` wins; otherwise the current directory. A relative
 * `--workspace` resolves against that same current directory, because that is
 * what a person typing `--workspace ./site` means and refusing it outright
 * would have made the ordinary form of the flag unusable. This is not a second
 * resolution rule: the domain owns both the resolution and the normalization,
 * and Git-aware discovery still belongs with the workspace capability in v0.2.
 */
function workspaceRootFrom(
  options: GlobalOptions,
  overrides: HostServiceOptions,
): LocalPath | null {
  const current = overrides.currentDirectory ?? currentDirectory();
  if (options.workspace === null) {
    return current;
  }
  // Text that can never name a path is refused at parse time and exits 2, so
  // reaching `null` here means the process itself has no nameable current
  // directory to resolve against. The command reports the missing layer in its
  // result rather than failing to construct.
  return current === null
    ? valueOrNull(parseLocalPath(options.workspace))
    : valueOrNull(resolveLocalPath(current, options.workspace));
}

function currentDirectory(): LocalPath | null {
  return valueOrNull(parseLocalPath(process.cwd()));
}

function valueOrNull(parsed: Result<LocalPath, LocalPathError>): LocalPath | null {
  return parsed.ok ? parsed.value : null;
}
