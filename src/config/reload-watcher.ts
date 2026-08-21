/**
 * Coalesced live reload for long-lived runs.
 *
 * Raw file events are never applied as configuration mutations. A burst of
 * watcher notifications is coalesced, then the loader re-reads every discovered
 * source and validates the full stack. An invalid refresh leaves the last valid
 * generation active — the loader's contract, not reimplemented here.
 */

import type { ClockPort, ConfigurationLoadOutcome, LocalPath } from "../domain/index.ts";
import type { ConfigurationLoader, LoadRequest } from "./loader.ts";

export type FileChangeSubscriber = (
  paths: readonly LocalPath[],
  onChange: () => void,
  signal?: AbortSignal,
) => Promise<{ readonly dispose: () => void }>;

export type ConfigurationReloadWatcherOptions = {
  readonly loader: ConfigurationLoader;
  readonly loadRequest: LoadRequest;
  readonly watchedPaths: readonly LocalPath[];
  readonly clock: ClockPort;
  /** Milliseconds to wait after the last file event before reloading. */
  readonly coalesceMs?: number;
  readonly subscribe: FileChangeSubscriber;
  readonly onReload: (outcome: ConfigurationLoadOutcome) => void;
  readonly signal?: AbortSignal;
};

export type ConfigurationReloadWatcher = {
  readonly dispose: () => void;
};

const DEFAULT_COALESCE_MS = 100;

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export function createConfigurationReloadWatcher(
  options: ConfigurationReloadWatcherOptions,
): ConfigurationReloadWatcher {
  const coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;
  let disposed = false;
  let subscription: { dispose: () => void } | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let reloading = false;
  let rerunAfterCurrent = false;

  const scheduleReload = (): void => {
    if (disposed || isAborted(options.signal)) {
      return;
    }
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
    }
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      void runReload();
    }, coalesceMs);
  };

  const runReload = async (): Promise<void> => {
    if (disposed || isAborted(options.signal)) {
      return;
    }
    if (reloading) {
      rerunAfterCurrent = true;
      return;
    }
    reloading = true;
    try {
      do {
        rerunAfterCurrent = false;
        const outcome = await options.loader.load(options.loadRequest, options.signal);
        options.onReload(outcome);
      } while (rerunAfterCurrent && !disposed && !isAborted(options.signal));
    } finally {
      reloading = false;
    }
  };

  void options.subscribe(options.watchedPaths, scheduleReload, options.signal).then((handle) => {
    if (disposed) {
      handle.dispose();
      return;
    }
    subscription = handle;
  });

  return {
    dispose: () => {
      disposed = true;
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      if (subscription !== null) {
        subscription.dispose();
        subscription = null;
      }
    },
  };
}
