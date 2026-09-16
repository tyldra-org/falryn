import { inspectGeneration } from "./inspection.ts";
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
  type ConfigurationChange,
  type ConfigurationGenerationRecord,
  type ConfigurationIssue,
  type ConfigurationLayerContext,
  type ConfigurationLoadOutcome,
  type ConfigurationRegistryPort,
  type ConfigurationScope,
  type ConfigurationSource,
  type ConfigurationSourceKind,
  isBlockingIssue,
  type SensitiveValueRedactor,
  type SourceReport,
} from "../../domain/configuration/index.ts";
import {
  type ClockPort,
  type ConfigurationGeneration,
  type EnvironmentPort,
  eventId,
  FIRST_CONFIGURATION_GENERATION,
  FIRST_SEQUENCE,
  idempotencyKey,
  nextSequence,
  ok,
  RUNTIME_EVENT_SCHEMA_VERSION,
  type Sequence,
  type StreamId,
  timestampFromEpochMilliseconds,
} from "../../domain/foundation/index.ts";
import type {
  ConfigurationApplicationClass,
  EventStorePort,
  SessionCorrelation,
} from "../../domain/sessions/index.ts";
import { createInMemoryEventStore } from "../../domain/sessions/index.ts";
import type { FileSystemPort, LocalPath } from "../../domain/workspace/index.ts";
import type { ConfigurationKeyDeclaration } from "../document/declaration.ts";
import { configurationHomeIssue, resolveConfigurationHome } from "../host/home.ts";
import { type BridgeResult, readEnvironmentLayer, readOverrideLayer } from "./bridges.ts";
import { composeLayers, declaredKeysOf, type LayerInput } from "./composition.ts";
import { diffGenerations, nextGeneration, strongestApplicationClass } from "./generation.ts";
import { discoverSources } from "./sources.ts";
import { readWorkingSources } from "./working-profile.ts";

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
  "private-project-file": "project",
  profile: "profile",
  environment: "environment",
  "cli-override": "cli",
};

export type ConfigurationLoaderOptions = {
  /** Initial session generation supplied by its host; later publications increment it. */
  readonly firstGeneration?: ConfigurationGeneration;
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
  /** Dynamic host-owned declarations are staged with the same complete source read. */
  readonly prepare?: (
    request: LoadRequest,
    signal?: AbortSignal,
  ) => Promise<{
    readonly registry: ConfigurationRegistryPort;
    readonly declarations: readonly ConfigurationKeyDeclaration[];
    readonly layers: readonly LayerInput[];
    readonly generation: string;
    readonly issues?: readonly ConfigurationIssue[];
    readonly publish: () => void;
  }>;
};

export type LoadRequest = {
  /** Product startup supplies inspected bytes; null explicitly disables project settings. */
  readonly projectText?: string | null;
  readonly privateProjectText?: string | null;
  /** Explicitly saved personal association supplied by the workspace owner. */
  readonly workspaceProfile?: string | null;
  readonly profileAncestry?: readonly string[];
  readonly configurationRoot: LocalPath;
  /** Previous platform-default root; absent for direct library callers. */
  readonly legacyConfigurationRoot?: LocalPath | null;
  readonly workspaceRoot: LocalPath | null;
  readonly profile: string | null;
  /** Key path to raw string, already parsed by the command owner. */
  readonly overrides?: Readonly<Record<string, string>>;
};

export type ConfigurationCandidate = {
  readonly kind: "candidate";
  readonly inspection: import("../../domain/configuration/index.ts").ConfigurationInspection;
  readonly record: ConfigurationGenerationRecord;
  readonly changes: readonly ConfigurationChange[];
  readonly applicationClass: ConfigurationApplicationClass;
  /** One-use publication of these exact bytes against the captured generation. */
  publish(signal?: AbortSignal): Promise<ConfigurationLoadOutcome>;
};
export type ConfigurationPreviewOutcome =
  | ConfigurationCandidate
  | Exclude<ConfigurationLoadOutcome, { kind: "published" }>;

export type ConfigurationLoader = {
  /** Resolve without publication or runtime preparation. */
  preview(request: LoadRequest, signal?: AbortSignal): Promise<ConfigurationPreviewOutcome>;
  /** Composes proposed bytes in isolation; never publishes into the running product. */
  validate(
    request: LoadRequest,
    candidate: { readonly path: LocalPath; readonly text: string },
    signal?: AbortSignal,
  ): Promise<readonly ConfigurationIssue[]>;
  /** Composes and, when anything changed, publishes a new generation. */
  load(request: LoadRequest, signal?: AbortSignal): Promise<ConfigurationLoadOutcome>;
  /** The generation currently in effect, or `null` before the first success. */
  current(): ConfigurationGenerationRecord | null;
};

export function createConfigurationLoader(
  initialOptions: ConfigurationLoaderOptions,
): ConfigurationLoader {
  let current: ConfigurationGenerationRecord | null = null;
  let sequence: Sequence = FIRST_SEQUENCE;
  let publishedSourceGeneration: string | null = null;
  let publishing = false;

  const loader: ConfigurationLoader = {
    current: () => current,
    async load(request, signal) {
      const candidate = await loader.preview(request, signal);
      return candidate.kind === "candidate" ? candidate.publish(signal) : candidate;
    },
    async validate(request, candidate, signal) {
      const fileSystem: FileSystemPort = {
        ...initialOptions.fileSystem,
        stat: async (path, abort) =>
          path === candidate.path
            ? ok({
                path,
                kind: "file",
                byteLength: new TextEncoder().encode(candidate.text).byteLength,
                mode: 0o600,
                revision: "candidate",
              })
            : initialOptions.fileSystem.stat(path, abort),
        readText: async (path, maximum, abort) =>
          path === candidate.path
            ? ok(candidate.text)
            : initialOptions.fileSystem.readText(path, maximum, abort),
      };
      const staged = createConfigurationLoader({
        ...initialOptions,
        fileSystem,
        eventStore: createInMemoryEventStore(),
        ...(initialOptions.prepare === undefined
          ? {}
          : {
              prepare: async (loadRequest: LoadRequest, abort?: AbortSignal) => {
                const prepared = await initialOptions.prepare?.(loadRequest, abort);
                if (prepared === undefined) throw new Error("configuration-prepare-unavailable");
                return { ...prepared, publish: () => {} };
              },
            }),
      });
      const result = await staged.load(
        {
          ...request,
          ...(candidate.path.endsWith("/.falryn/local/falryn.local.jsonc")
            ? { privateProjectText: candidate.text }
            : {}),
          ...(candidate.path ===
          discoverSources(request).sources.find((source) => source.source.kind === "project-file")
            ?.file
            ? { projectText: candidate.text }
            : {}),
        },
        signal,
      );
      if (result.kind === "published" || result.kind === "unchanged") {
        if (
          result.record.sources.some((source) =>
            ["unreadable", "oversized", "malformed-encoding", "malformed-syntax"].includes(
              source.outcome,
            ),
          )
        ) {
          return [{ kind: "invalid-value", severity: "error", path: "", allowed: [] }];
        }
        return result.record.issues;
      }
      if (result.kind === "rejected") return result.issues;
      return [{ kind: "invalid-value", severity: "error", path: "", allowed: [] }];
    },

    async preview(
      request: LoadRequest,
      signal?: AbortSignal,
    ): Promise<ConfigurationPreviewOutcome> {
      const previous = current;
      if (isAborted(signal)) {
        return { kind: "cancelled" };
      }

      const home = await resolveConfigurationHome(
        initialOptions.fileSystem,
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
          sources: [],
          retained: current,
        };
      }

      const working = await readWorkingSources(
        initialOptions.fileSystem,
        {
          ...request,
          configurationRoot: home.root,
        },
        signal,
      );
      let prepared:
        | Awaited<ReturnType<NonNullable<ConfigurationLoaderOptions["prepare"]>>>
        | undefined;
      try {
        prepared = await initialOptions.prepare?.(
          {
            ...request,
            profile: working.selection.id,
            profileAncestry: working.selection.ancestry.map((entry) => entry.id),
          },
          signal,
        );
      } catch {
        return {
          kind: "publish-failed",
          code: "package-configuration-unavailable",
          retained: current,
        };
      }
      const options =
        prepared === undefined
          ? initialOptions
          : { ...initialOptions, registry: prepared.registry, declarations: prepared.declarations };

      const reports: SourceReport[] = [];
      const layers: LayerInput[] = [...(prepared?.layers ?? [])].filter(
        (layer) => layer.source.kind !== "profile",
      );
      const issues: ConfigurationIssue[] = [...(prepared?.issues ?? [])];

      issues.push(...working.issues);
      for (const read of working.reads) {
        if (read.source.kind === "profile")
          layers.push(
            ...(prepared?.layers ?? []).filter(
              (layer) =>
                layer.source.kind === "profile" && layer.source.profile === read.source.profile,
            ),
          );
        if (isAborted(signal)) return { kind: "cancelled" };
        const pinned = read.source.kind === "project-file" && request.projectText !== undefined;
        if (read.outcome !== "loaded") {
          // Removing or losing a previously loaded package source must not silently
          // revert its settings while an admitted operation still holds that generation.
          if (
            current !== null &&
            !(pinned && request.projectText === null) &&
            options.declarations.some((d) => d.descriptor.path.startsWith("packages.")) &&
            current.sources.some(
              (source) => source.source.file === read.source.file && source.outcome === "loaded",
            )
          )
            return {
              kind: "publish-failed",
              code: "package-configuration-source-unavailable",
              retained: current,
            };
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
        layers.push({
          source: read.source,
          scope,
          values: validated.values,
          schemaVersion: read.source.schemaVersion ?? 1,
        });
      }

      if (working.selection.virtual)
        layers.push(...(prepared?.layers ?? []).filter((layer) => layer.source.kind === "profile"));
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

      const sourceRevisions: { file: LocalPath; revision: string | null }[] = [];
      for (const read of working.reads) {
        if (
          read.source.file === null ||
          (read.source.kind === "project-file" && request.projectText !== undefined) ||
          (read.source.kind === "private-project-file" && request.privateProjectText !== undefined)
        )
          continue;
        const latest = await initialOptions.fileSystem.stat(read.source.file, signal);
        if (
          read.source.revision != null &&
          (!latest.ok || latest.value?.revision !== read.source.revision)
        )
          return {
            kind: "publish-failed",
            code: "configuration-source-changed",
            retained: current,
          };
        sourceRevisions.push({
          file: read.source.file,
          revision: latest.ok ? (latest.value?.revision ?? null) : null,
        });
      }

      const record: ConfigurationGenerationRecord = freezeConfiguration({
        workingProfile: working.selection,
        generation: nextGeneration(
          current,
          initialOptions.firstGeneration ?? FIRST_CONFIGURATION_GENERATION,
        ),
        values: composed.values,
        provenance: composed.provenance,
        overridden: composed.overridden,
        sources: reports,
        issues,
      });

      const changes =
        current === null
          ? diffGenerations(options.registry, {}, composed.values)
          : diffGenerations(options.registry, current.values, composed.values);

      if (
        current !== null &&
        changes.length === 0 &&
        (prepared?.generation ?? null) === publishedSourceGeneration &&
        JSON.stringify({
          workingProfile: working.selection,
          sources: reports,
          provenance: composed.provenance,
          overridden: composed.overridden,
          issues,
        }) ===
          JSON.stringify({
            workingProfile: current.workingProfile,
            sources: current.sources,
            provenance: current.provenance,
            overridden: current.overridden,
            issues: current.issues,
          })
      ) {
        // Nothing moved. No generation is allocated and no event is appended,
        // so a caller polling this cannot manufacture a change per poll.
        return { kind: "unchanged", record: current };
      }

      const applicationClass = strongestApplicationClass(changes);
      let consumed = false;
      return {
        kind: "candidate",
        record,
        changes,
        applicationClass,
        inspection: inspectGeneration(options.registry, record),
        async publish(abort) {
          const failed = (code: string): ConfigurationLoadOutcome => ({
            kind: "publish-failed",
            code,
            retained: current,
          });
          if (consumed || current !== previous) return failed("configuration-generation-changed");
          if (publishing) return failed("configuration-publication-busy");
          if (isAborted(abort)) return { kind: "cancelled" };
          publishing = true;
          consumed = true;
          try {
            for (const source of sourceRevisions) {
              const latest = await initialOptions.fileSystem.stat(source.file, abort);
              if ((latest.ok ? (latest.value?.revision ?? null) : null) !== source.revision)
                return failed("configuration-source-changed");
            }
            if (isAborted(abort)) return { kind: "cancelled" };
            if (current !== previous) return failed("configuration-generation-changed");
            const appended = await appendGenerationEvent(
              options,
              record.generation,
              applicationClass,
              sequence,
              abort,
            );
            if (!appended.ok) return failed(appended.code);
            sequence = nextSequence(sequence);
            current = record;
            publishedSourceGeneration = prepared?.generation ?? null;
            prepared?.publish();
            return { kind: "published", record, changes, applicationClass };
          } finally {
            publishing = false;
          }
        },
      };
    },
  };
  return loader;
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

/** Published JSON values cannot be changed by a consumer holding the generation. */
function freezeConfiguration<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeConfiguration(child);
    Object.freeze(value);
  }
  return value;
}
