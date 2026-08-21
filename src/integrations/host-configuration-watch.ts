/**
 * Host file-change subscription for configuration reload.
 *
 * Uses the platform `fs.watch` API behind the integrations boundary. The
 * configuration reload watcher coalesces notifications before calling the
 * loader — raw events are never applied as configuration mutations.
 */

import { type FSWatcher, watch } from "node:fs";

import type { LocalPath } from "../domain/index.ts";

export type HostFileChangeSubscriber = (
  paths: readonly LocalPath[],
  onChange: () => void,
  signal?: AbortSignal,
) => Promise<{ readonly dispose: () => void }>;

/** Subscribes to changes on absolute paths and reports them upward. */
export function createHostFileChangeSubscriber(): HostFileChangeSubscriber {
  return async (paths, onChange, signal) => {
    const watchers: FSWatcher[] = [];
    const watched = new Set<string>();

    for (const path of paths) {
      if (watched.has(path)) {
        continue;
      }
      watched.add(path);
      try {
        const watcher = watch(path, (eventType) => {
          if (eventType === "change" || eventType === "rename") {
            onChange();
          }
        });
        watchers.push(watcher);
      } catch {
        // A missing path is ordinary before first write; reload still runs on
        // other sources and the next explicit load will surface absence.
      }
    }

    const onAbort = (): void => {
      for (const watcher of watchers) {
        watcher.close();
      }
    };
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    return {
      dispose: onAbort,
    };
  };
}

/** In-memory subscriber for tests: call `trigger()` to simulate a file change. */
export function createManualFileChangeSubscriber(): HostFileChangeSubscriber & {
  trigger(): void;
} {
  let handler: (() => void) | null = null;
  const subscriber: HostFileChangeSubscriber = async (_paths, onChange, signal) => {
    handler = onChange;
    const onAbort = (): void => {
      handler = null;
    };
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
    return { dispose: onAbort };
  };
  return Object.assign(subscriber, {
    trigger: (): void => {
      handler?.();
    },
  });
}
