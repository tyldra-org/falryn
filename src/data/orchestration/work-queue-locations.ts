/** Storage locators are registered by the host, never interpreted as task-supplied paths. */

import type { ClockPort } from "../../domain/foundation/index.ts";
import { err, ok } from "../../domain/foundation/result.ts";
import {
  refuseWork,
  type WorkQueueStore,
  type WorkResult,
  type WorkScope,
} from "../../domain/orchestration/work-queue.ts";
import type { SqliteOpener, SqliteStorePort } from "../../domain/storage/index.ts";
import type { LocalPath } from "../../domain/workspace/index.ts";
import { PRODUCTION_MIGRATIONS } from "../sqlite/sqlite-migrations.ts";
import { openSqliteStore } from "../sqlite/sqlite-store.ts";
import { createSqliteWorkQueueStore } from "./work-queue-store.ts";

export type WorkQueueLocations = ReturnType<typeof createWorkQueueLocations>;
export function createWorkQueueLocations(input: {
  readonly state: SqliteStorePort;
  readonly open: SqliteOpener;
  readonly stateRoot: LocalPath;
  readonly clock: ClockPort;
  /** Additional stores have already passed the root/storage owner's admission. */
  readonly registered?: readonly WorkQueueStore[];
}) {
  const locations = new Map<string, WorkQueueStore>([
    [
      "workspace-state",
      createSqliteWorkQueueStore(input.state, {
        locator: "workspace-state",
        durability: "durable",
      }),
    ],
    [
      "user-state",
      createSqliteWorkQueueStore(input.state, { locator: "user-state", durability: "durable" }),
    ],
  ]);
  for (const store of input.registered ?? []) {
    if (locations.has(store.locator) || store.locator === "memory")
      throw new Error("duplicate-work-queue-location");
    locations.set(store.locator, store);
  }
  let ephemeral: Promise<WorkQueueStore | null> | null = null;
  let memory: SqliteStorePort | null = null;
  let closed = false;
  async function at(locator: string): Promise<WorkQueueStore | null> {
    if (closed) return null;
    if (locator !== "memory") return locations.get(locator) ?? null;
    ephemeral ??= (async () => {
      const result = await openSqliteStore({
        open: input.open,
        clock: input.clock,
        databasePath: ":memory:",
        backupDirectory: input.stateRoot,
        migrations: PRODUCTION_MIGRATIONS,
      });
      if (!result.ok) return null;
      memory = result.value;
      if (closed) {
        await memory.close();
        return null;
      }
      const store = createSqliteWorkQueueStore(memory, {
        locator: "memory",
        durability: "ephemeral",
      });
      locations.set("memory", store);
      return store;
    })();
    return ephemeral;
  }
  return {
    at,
    async select(input: {
      sessionId: string;
      workspaceId: string;
      persistentSession: boolean;
      scope?: WorkScope["kind"];
      locator?: string;
    }): Promise<
      WorkResult<{ store: WorkQueueStore; scope: WorkScope["kind"]; existingQueue: string | null }>
    > {
      if (closed) return err({ code: "unavailable" });
      // Resume the recorded locator before consulting defaults. Missing registered locations are
      // explicit when selected; callers must retain the returned locator with the session.
      let existing: {
        store: WorkQueueStore;
        scope: WorkScope["kind"];
        existingQueue: string;
      } | null = null;
      for (const store of locations.values()) {
        const found = store.transaction((tx) => {
          const id = tx.binding(input.sessionId, input.workspaceId);
          const queue = id === null ? null : tx.queue(id);
          if (id !== null && queue === null) refuseWork("recovery-required");
          return queue;
        });
        if (!found.ok) return found;
        if (found.value !== null) {
          const selected = await at(found.value.scope.locator);
          if (selected === null) return err({ code: "unavailable" });
          if (
            existing !== null &&
            (existing.store.locator !== selected.locator ||
              existing.existingQueue !== found.value.id)
          )
            return err({ code: "recovery-required" });
          existing = {
            store: selected,
            scope: found.value.scope.kind,
            existingQueue: found.value.id,
          };
        }
      }
      if (existing !== null) return ok(existing);
      const scope = input.scope ?? "session";
      const useMemory =
        scope === "memory" ||
        (!input.persistentSession && ["session", "session-global"].includes(scope));
      const store = await at(
        useMemory
          ? "memory"
          : (input.locator ??
              (scope === "session" || scope === "project" ? "workspace-state" : "user-state")),
      );
      return store === null
        ? err({ code: "unavailable" })
        : ok({ store, scope, existingQueue: null });
    },
    async close(): Promise<boolean> {
      closed = true;
      await ephemeral;
      return memory === null || (await memory.close()).closed;
    },
  };
}
