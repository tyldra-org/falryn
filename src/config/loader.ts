/**
 * The configuration load lifecycle, end to end.
 *
 * ```text
 * discover → read bounded bytes → parse → schema validate → compose
 *          → cross-validate → diff current → classify application → publish
 * ```
 *
 * The loader owns the order and owns nothing else: discovery, parsing,
 * composition, diffing, and classification each live in their own module, and
 * the filesystem and environment arrive as ports. That is what lets the whole
 * lifecycle be tested without a disk.
 *
 * **An invalid refresh leaves the last valid generation active.** Composition
 * failing is not an occasion to run with nothing; it is an occasion to keep
 * running with what already worked and say loudly why the new attempt was
 * refused. In-flight operations keep the generation their context bound, which
 * the runtime context already guarantees.
 */

import {
  type ClockPort,
  type ConfigurationApplicationClass,
  type ConfigurationGeneration,
  type ConfigurationGenerationRecord,
  type ConfigurationIssue,
  type ConfigurationLayerContext,
  type ConfigurationLoadOutcome,
  type ConfigurationRegistryPort,
  type ConfigurationScope,
  type ConfigurationSource,
  type ConfigurationSourceKind,
  type EnvironmentPort,
  type EventStorePort,
  eventId,
  FIRST_CONFIGURATION_GENERATION,
  FIRST_SEQUENCE,
  type FileSystemPort,
  idempotencyKey,
  isBlockingIssue,
  type LocalPath,
  nextSequence,
  RUNTIME_EVENT_SCHEMA_VERSION,
  type SensitiveValueRedactor,
  type Sequence,
  type SessionCorrelation,
  type SourceReport,
  type StreamId,
  timestampFromEpochMilliseconds,
} from "../domain/index.ts";
import { type BridgeResult, readEnvironmentLayer, readOverrideLayer } from "./bridges.ts";
import { composeLayers, declaredKeysOf, type LayerInput } from "./composition.ts";
import type { ConfigurationKeyDeclaration } from "./declaration.ts";
import { diffGenerations, nextGeneration, strongestApplicationClass } from "./generation.ts";
import { configurationHomeIssue, resolveConfigurationHome } from "./home.ts";
import { discoverSources, readSource } from "./sources.ts";

/**
 * Re-reads the abort flag without letting the compiler narrow it away.
 *
 * `AbortSignal.aborted` is a mutable getter typed as a readonly property, so a
 * direct `signal?.aborted === true` early in a function narrows every later
 * read to `false` and the compiler rejects the re-check as unreachable. The
 * removal executor carries the same guard for the same reason; a third caller
 * should hoist this into the domain rather than a fourth copy appearing.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Which scope each file layer sets values from. */
const SCOPE_BY_KIND: Readonly<Record<ConfigurationSourceKind, ConfigurationScope | null>> = {
  "built-in-default": null,
  "user-file": "user",
  "project-file": "project",
  profile: "profile",
  environment: "environment",
  "cli-override": "cli",
};

export type ConfigurationLoaderOptions = {
  readonly registry: ConfigurationRegistryPort;
  readonly declarations: readonly ConfigurationKeyDeclaration[];
  readonly fileSystem: FileSystemPort;
  readonly environment: EnvironmentPort;
  readonly redactor: SensitiveValueRedactor;
  readonly clock: ClockPort;
  /** Where the generation event is appended. Durable storage is #13's. */
  readonly eventStore: EventStorePort;
  /** Identities the event's correlation needs, supplied by the caller. */
  readonly correlation: Omit<SessionCorrelation, "configurationGeneration">;
  readonly streamId: StreamId;
};

export type LoadRequest = {
  readonly configurationRoot: LocalPath;
  /** Previous platform-default root; absent for direct library callers. */
  readonly legacyConfigurationRoot?: LocalPath | null;
  readonly workspaceRoot: LocalPath | null;
  readonly profile: string | null;
  /** Key path to raw string, already parsed by the command owner. */
  readonly overrides?: Readonly<Record<string, string>>;
};

export type ConfigurationLoader = {
  /** Composes and, when anything changed, publishes a new generation. */
  load(request: LoadRequest, signal?: AbortSignal): Promise<ConfigurationLoadOutcome>;
  /** The generation currently in effect, or `null` before the first success. */
  current(): ConfigurationGenerationRecord | null;
};

export function createConfigurationLoader(
  options: ConfigurationLoaderOptions,
): ConfigurationLoader {
  let current: ConfigurationGenerationRecord | null = null;
  let sequence: Sequence = FIRST_SEQUENCE;

  return {
    current: () => current,

    async load(request: LoadRequest, signal?: AbortSignal): Promise<ConfigurationLoadOutcome> {
      if (isAborted(signal)) {
        return { kind: "cancelled" };
      }

      const reports: SourceReport[] = [];
      const layers: LayerInput[] = [];
      const issues: ConfigurationIssue[] = [];

      const home = await resolveConfigurationHome(
        options.fileSystem,
        {
          current: request.configurationRoot,
          legacy: request.legacyConfigurationRoot ?? null,
        },
        signal,
      );
      if (home.kind === "cancelled") {
        return { kind: "cancelled" };
      }
      if (home.kind === "conflict" || home.kind === "unavailable") {
        return {
          kind: "rejected",
          issues: [configurationHomeIssue(home)],
          sources: reports,
          retained: current,
        };
      }

      const discovery = discoverSources({
        configurationRoot: home.root,
        workspaceRoot: request.workspaceRoot,
        profile: request.profile,
      });
      issues.push(...discovery.issues);

      for (const discovered of discovery.sources) {
        if (isAborted(signal)) {
          return { kind: "cancelled" };
        }
        const read = await readSource(options.fileSystem, discovered, signal);
        if (read.outcome !== "loaded") {
          reports.push({
            source: read.source,
            outcome: read.outcome,
            issues: read.issues,
            declaredKeys: [],
            position: read.position,
          });
          issues.push(...read.issues);
          continue;
        }

        const scope = SCOPE_BY_KIND[read.source.kind];
        const context: ConfigurationLayerContext = {
          scope: scope ?? "user",
          sourceKind: read.source.kind,
        };
        const validated = options.registry.validateLayer(read.document, context);
        if (!validated.ok) {
          // The file parsed but does not describe a valid configuration. The
          // loop continues so that every source still gets a report, but the
          // issues it raises are blocking, so the load as a whole is refused
          // below and the previous generation stays in effect. Dropping the
          // file and carrying on would apply a configuration the user did not
          // write — the same failure as accepting the mistyped key.
          reports.push({
            source: read.source,
            outcome: "rejected",
            issues: validated.issues,
            declaredKeys: [],
            position: null,
          });
          issues.push(...validated.issues);
          continue;
        }

        reports.push({
          source: read.source,
          outcome: "loaded",
          issues: validated.issues,
          declaredKeys: declaredKeysOf(validated.values),
          position: null,
        });
        issues.push(...validated.issues);
        layers.push({ source: read.source, scope, values: validated.values });
      }

      const environmentSource: ConfigurationSource = {
        kind: "environment",
        file: null,
        profile: null,
      };
      const environment = readEnvironmentLayer(options.registry, options.environment);
      pushSupplied(reports, issues, layers, environmentSource, environment, "environment");

      const overrideSource: ConfigurationSource = {
        kind: "cli-override",
        file: null,
        profile: null,
      };
      const overrides = readOverrideLayer(options.registry, request.overrides ?? {});
      pushSupplied(reports, issues, layers, overrideSource, overrides, "cli");

      const composed = composeLayers({
        registry: options.registry,
        declarations: options.declarations,
        redactor: options.redactor,
        layers,
      });
      issues.push(...composed.issues);
      issues.push(...options.registry.crossValidate(composed.values));

      if (issues.some(isBlockingIssue)) {
        // The previous generation stays in effect. Returning nothing usable
        // would replace a working configuration with none.
        return { kind: "rejected", issues, sources: reports, retained: current };
      }

      const record: ConfigurationGenerationRecord = {
        generation: nextGeneration(current, FIRST_CONFIGURATION_GENERATION),
        values: composed.values,
        provenance: composed.provenance,
        overridden: composed.overridden,
        sources: reports,
        issues,
      };

      const changes =
        current === null
          ? diffGenerations(options.registry, {}, composed.values)
          : diffGenerations(options.registry, current.values, composed.values);

      if (current !== null && changes.length === 0) {
        // Nothing moved. No generation is allocated and no event is appended,
        // so a caller polling this cannot manufacture a change per poll.
        return { kind: "unchanged", record: current };
      }

      const applicationClass = strongestApplicationClass(changes);
      const appended = await appendGenerationEvent(
        options,
        record.generation,
        applicationClass,
        sequence,
        signal,
      );
      if (!appended.ok) {
        return { kind: "publish-failed", code: appended.code, retained: current };
      }
      sequence = nextSequence(sequence);
      current = record;

      return { kind: "published", record, changes, applicationClass };
    },
  };
}

function pushSupplied(
  reports: SourceReport[],
  issues: ConfigurationIssue[],
  layers: LayerInput[],
  source: ConfigurationSource,
  result: BridgeResult,
  scope: ConfigurationScope,
): void {
  const declared = Object.keys(result.values);
  reports.push({
    source,
    outcome: declared.length === 0 ? "empty" : "loaded",
    issues: result.issues,
    declaredKeys: declaredKeysOf(result.values),
    position: null,
  });
  issues.push(...result.issues);
  if (declared.length > 0) {
    layers.push({ source, scope, values: result.values });
  }
}

/**
 * Appends the one event this lifecycle produces.
 *
 * The idempotency key is the generation itself, so re-appending a generation is
 * a duplicate receipt rather than a second event — which is what makes a retry
 * after an ambiguous failure safe.
 *
 * That identity is unique per loader, not per machine: generation numbering
 * restarts at zero with each loader, as does the stream sequence. Against the
 * in-memory store both are correct, because the store's lifetime is the
 * loader's. Once persistence outlives the process, a second run's generation
 * zero would collide with the first's, and both the generation counter and the
 * sequence need to resume from what was stored rather than from their first
 * value. That is the persistence owner's to resolve, and it is why neither
 * counter is treated here as durable.
 */
async function appendGenerationEvent(
  options: ConfigurationLoaderOptions,
  generation: ConfigurationGeneration,
  applicationClass: ConfigurationApplicationClass,
  sequence: Sequence,
  signal?: AbortSignal,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string }> {
  const identity = `configuration-generation-${generation}`;
  const appended = await options.eventStore.append(
    {
      eventId: eventId.from(identity),
      streamId: options.streamId,
      sequence,
      kind: "configuration.generation.changed",
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      minimumReaderSchemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      occurredAt: timestampFromEpochMilliseconds(options.clock.now()),
      idempotencyKey: idempotencyKey.from(identity),
      correlation: { ...options.correlation, configurationGeneration: generation },
      payload: { generation, applicationClass },
    },
    signal,
  );

  // An event-store failure is not a configuration failure, so it is reported as
  // itself rather than squeezed into a validation issue that would name a key
  // path nothing is wrong with.
  return appended.ok ? { ok: true } : { ok: false, code: appended.error.code };
}
