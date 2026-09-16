/**
 * Live configuration reload for long-lived CLI surfaces (#729).
 *
 * Watches discovered source paths, coalesces file events, and reloads through
 * the service graph's loader. Invalid refresh is reported on the diagnostic
 * handle and leaves the last valid generation in effect.
 */

import { fromConfigurationIssues } from "../../application/diagnostics/index.ts";
import {
  configurationSourcePaths,
  createConfigurationReloadWatcher,
  type FileChangeSubscriber,
} from "../../config/index.ts";
import type { ConfigurationLoadOutcome } from "../../domain/configuration/index.ts";
import { parentPath } from "../../domain/workspace/index.ts";
import { createHostFileChangeSubscriber } from "../../integrations/index.ts";
import type { GlobalOptions } from "../options.ts";
import { type CliStreams, writeDiagnosticLine } from "../output/streams.ts";
import {
  loadProductConfiguration,
  type ProductConfigurationLoadRequest,
  productConfigurationLoadRequest,
} from "./product-configuration.ts";
import type { Services } from "./services.ts";

export type ConfigurationReloadHandle = {
  readonly dispose: () => void;
};

/** Starts watching configuration sources and reloading through the graph loader. */
export function startConfigurationReloadWatcher(
  graph: Services,
  globals: GlobalOptions,
  options: {
    readonly streams?: CliStreams;
    readonly signal?: AbortSignal;
    readonly loadRequest?: ProductConfigurationLoadRequest;
    readonly subscribe?: FileChangeSubscriber;
    /** Session transition owner handles invalidation without preparing or publishing. */
    readonly onInvalidation?: (signal?: AbortSignal) => void | Promise<void>;
  } = {},
): ConfigurationReloadHandle {
  const loadRequest = options.loadRequest ?? productConfigurationLoadRequest(globals);
  const files = [
    ...(graph.loader
      .current()
      ?.sources.flatMap((entry) => (entry.source.file === null ? [] : [entry.source.file])) ?? []),
    ...configurationSourcePaths(graph.configurationRoot, graph.workspaceRoot, loadRequest.profile),
    ...(graph.legacyConfigurationRoot === null
      ? []
      : configurationSourcePaths(
          graph.legacyConfigurationRoot,
          graph.workspaceRoot,
          loadRequest.profile,
        )),
  ].filter((path, index, all) => all.indexOf(path) === index);
  const paths = [
    ...new Set([
      ...files,
      ...files.flatMap((file) => {
        const parent = parentPath(file);
        return parent === null ? [] : [parent];
      }),
    ]),
  ];
  const streams = options.streams;
  return createConfigurationReloadWatcher({
    loader: {
      load: async (_request, signal) => {
        if (options.onInvalidation) {
          await options.onInvalidation(signal);
          const record = graph.loader.current();
          return record ? { kind: "unchanged", record } : { kind: "cancelled" };
        }
        try {
          return (await loadProductConfiguration(graph, loadRequest, signal)).outcome;
        } catch {
          return {
            kind: "publish-failed",
            code: "configuration-read-failed",
            retained: graph.loader.current(),
          };
        }
      },
    },
    loadRequest: {
      configurationRoot: graph.configurationRoot,
      legacyConfigurationRoot: graph.legacyConfigurationRoot,
      workspaceRoot: graph.workspaceRoot,
      profile: loadRequest.profile,
      overrides: loadRequest.overrides,
    },
    watchedPaths: paths,
    clock: graph.clock,
    subscribe: options.subscribe ?? createHostFileChangeSubscriber(),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    onReload: (outcome) => {
      reportReloadOutcome(outcome, streams);
    },
  });
}

function reportReloadOutcome(
  outcome: ConfigurationLoadOutcome,
  streams: CliStreams | undefined,
): void {
  if (streams === undefined) {
    return;
  }
  switch (outcome.kind) {
    case "published":
      writeDiagnosticLine(
        streams,
        `Configuration reloaded (generation ${outcome.record.generation}, ${outcome.applicationClass}).`,
      );
      return;
    case "unchanged":
      return;
    case "rejected": {
      const error = fromConfigurationIssues(outcome.issues, { operation: "reload configuration" });
      writeDiagnosticLine(
        streams,
        error === null
          ? "Configuration reload was refused; the previous generation remains in effect."
          : `${error.message} The previous generation remains in effect.`,
      );
      return;
    }
    case "publish-failed":
      writeDiagnosticLine(
        streams,
        outcome.code === "configuration-read-failed"
          ? "Configuration could not be read. The previous generation remains in effect."
          : `Configuration was valid but could not be recorded (${outcome.code}). The previous generation remains in effect.`,
      );
      return;
    case "cancelled":
      return;
    default:
      return;
  }
}
