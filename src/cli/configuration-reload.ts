/**
 * Live configuration reload for long-lived CLI surfaces (#729).
 *
 * Watches discovered source paths, coalesces file events, and reloads through
 * the service graph's loader. Invalid refresh is reported on the diagnostic
 * handle and leaves the last valid generation in effect.
 */

import { fromConfigurationIssues } from "../application/index.ts";
import {
  configurationSourcePaths,
  createConfigurationReloadWatcher,
  type FileChangeSubscriber,
} from "../config/index.ts";
import type { ConfigurationLoadOutcome } from "../domain/index.ts";
import { createHostFileChangeSubscriber } from "../integrations/index.ts";
import type { GlobalOptions } from "./options.ts";
import {
  type ProductConfigurationLoadRequest,
  productConfigurationLoadRequest,
} from "./product-configuration.ts";
import type { Services } from "./services.ts";
import { type CliStreams, writeDiagnosticLine } from "./streams.ts";

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
  } = {},
): ConfigurationReloadHandle {
  const loadRequest = options.loadRequest ?? productConfigurationLoadRequest(globals);
  const paths = configurationSourcePaths(
    graph.configurationRoot,
    graph.workspaceRoot,
    loadRequest.profile,
  );
  const streams = options.streams;
  return createConfigurationReloadWatcher({
    loader: graph.loader,
    loadRequest: {
      configurationRoot: graph.configurationRoot,
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
        `Configuration was valid but could not be recorded (${outcome.code}). The previous generation remains in effect.`,
      );
      return;
    case "cancelled":
      return;
    default:
      return;
  }
}
