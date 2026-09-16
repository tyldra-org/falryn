/**
 * Coalesced live reload for long-lived runs.
 *
 * Raw file events are never applied as configuration mutations. A burst of
 * watcher notifications is coalesced, then the loader re-reads every discovered
 * source and validates the full stack. An invalid refresh leaves the last valid
 * generation active — the loader's contract, not reimplemented here.
 */

import type { ConfigurationLoadOutcome } from "../../domain/configuration/index.ts";
import type { ClockPort } from "../../domain/foundation/index.ts";
import type { LocalPath } from "../../domain/workspace/index.ts";
import type { ConfigurationLoader, LoadRequest } from "../resolution/loader.ts";

export type FileChangeSubscriber = (
  paths: readonly LocalPath[],
  onChange: () => void,
  signal?: AbortSignal,
) => Promise<{ readonly dispose: () => void }>;

export type ConfigurationReloadWatcherOptions = {
  readonly loader: Pick<ConfigurationLoader, "load">;
  readonly loadRequest: LoadRequest;
  readonly watchedPaths: readonly LocalPath[];
  readonly clock: ClockPort;
  /** Milliseconds to wait after the last file event before reloading. */
  readonly coalesceMs?: number;
  readonly maxCoalesceMs?: number;
  /** Periodic full reread recovers notifications lost by the host watcher. */
  readonly rescanMs?: number;
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
  let maximumTimer: ReturnType<typeof setTimeout> | null = null;
  let reloading = false;
  let rerunAfterCurrent = false;

  const scheduleReload = (): void => {
    if (disposed || isAborted(options.signal)) {
      return;
    }
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
    }
    pendingTimer = setTimeout(flush, coalesceMs);
    maximumTimer ??= setTimeout(flush, options.maxCoalesceMs ?? 1000);
  };

  const flush = (): void => {
    if (pendingTimer !== null) clearTimeout(pendingTimer);
    if (maximumTimer !== null) clearTimeout(maximumTimer);
    pendingTimer = null;
    maximumTimer = null;
    void runReload();
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
    } catch {
      options.onReload({
        kind: "publish-failed",
        code: "configuration-read-failed",
        retained: null,
      });
    } finally {
      reloading = false;
    }
  };

  const rescanTimer = setInterval(flush, options.rescanMs ?? 30000);
  rescanTimer.unref();
  void options
    .subscribe(options.watchedPaths, scheduleReload, options.signal)
    .then((handle) => {
      if (disposed) {
        handle.dispose();
        return;
      }
      subscription = handle;
    })
    .catch(() => {
      // The periodic full reread remains active after notification delivery fails.
      if (!disposed && !isAborted(options.signal)) flush();
    });

  return {
    dispose: () => {
      disposed = true;
      clearInterval(rescanTimer);
      if (maximumTimer !== null) clearTimeout(maximumTimer);
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
