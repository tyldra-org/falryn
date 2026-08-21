import { describe, expect, test } from "bun:test";

import { createRuntimeRedactor } from "../application/index.ts";
import {
  createInMemoryEventStore,
  createInMemoryFileSystem,
  createManualClock,
  createStaticEnvironment,
  localPath,
  sessionId,
  streamId,
  traceId,
  workspaceId,
} from "../domain/index.ts";
import { createManualFileChangeSubscriber } from "../integrations/host-configuration-watch.ts";
import { V0_1_CONFIGURATION_KEYS, V0_1_CROSS_FIELD_RULES } from "./keys.ts";
import { createConfigurationLoader } from "./loader.ts";
import { createConfigurationRegistry } from "./registry.ts";
import { createConfigurationReloadWatcher } from "./reload-watcher.ts";
import { CONFIGURATION_FILE_NAME } from "./sources.ts";

const CONFIG_ROOT = localPath("/d/config");
const USER_FILE = `/d/config/${CONFIGURATION_FILE_NAME}`;

describe("configuration reload watcher", () => {
  test("coalesces file events and reloads through the loader", async () => {
    const registry = createConfigurationRegistry({
      declarations: V0_1_CONFIGURATION_KEYS,
      crossFieldRules: V0_1_CROSS_FIELD_RULES,
      redactor: createRuntimeRedactor(),
    });
    const fileSystem = createInMemoryFileSystem({
      nodes: {
        "/d/config": { kind: "directory" },
        [USER_FILE]: {
          kind: "file",
          text: `{ "schemaVersion": 1, "diagnostics": { "level": "info" } }`,
        },
      },
    });
    const eventStore = createInMemoryEventStore();
    const loader = createConfigurationLoader({
      registry,
      declarations: V0_1_CONFIGURATION_KEYS,
      fileSystem,
      environment: createStaticEnvironment({}),
      redactor: createRuntimeRedactor(),
      clock: createManualClock(),
      eventStore,
      correlation: {
        workspaceId: workspaceId.from("workspace-1"),
        sessionId: sessionId.from("session-1"),
        traceId: traceId.from("trace-1"),
      },
      streamId: streamId.from("configuration"),
    });
    const subscribe = createManualFileChangeSubscriber();
    const outcomes: string[] = [];
    const watcher = createConfigurationReloadWatcher({
      loader,
      loadRequest: { configurationRoot: CONFIG_ROOT, workspaceRoot: null, profile: null },
      watchedPaths: [localPath(USER_FILE)],
      clock: createManualClock(),
      coalesceMs: 1,
      subscribe,
      onReload: (outcome) => {
        outcomes.push(outcome.kind);
      },
    });

    await fileSystem.writeBytes(
      localPath(USER_FILE),
      new TextEncoder().encode(`{ "schemaVersion": 1, "diagnostics": { "level": "warn" } }\n`),
    );
    subscribe.trigger();
    await new Promise((resolve) => setTimeout(resolve, 20));

    watcher.dispose();
    expect(outcomes).toContain("published");
    expect(loader.current()?.values["diagnostics.level"]).toBe("warn");
  });

  test("keeps the last valid generation when reload is refused", async () => {
    const registry = createConfigurationRegistry({
      declarations: V0_1_CONFIGURATION_KEYS,
      crossFieldRules: V0_1_CROSS_FIELD_RULES,
      redactor: createRuntimeRedactor(),
    });
    const fileSystem = createInMemoryFileSystem({
      nodes: {
        "/d/config": { kind: "directory" },
        [USER_FILE]: {
          kind: "file",
          text: `{ "schemaVersion": 1, "diagnostics": { "level": "info" } }`,
        },
      },
    });
    const eventStore = createInMemoryEventStore();
    const loader = createConfigurationLoader({
      registry,
      declarations: V0_1_CONFIGURATION_KEYS,
      fileSystem,
      environment: createStaticEnvironment({}),
      redactor: createRuntimeRedactor(),
      clock: createManualClock(),
      eventStore,
      correlation: {
        workspaceId: workspaceId.from("workspace-1"),
        sessionId: sessionId.from("session-1"),
        traceId: traceId.from("trace-1"),
      },
      streamId: streamId.from("configuration"),
    });
    const first = await loader.load({
      configurationRoot: CONFIG_ROOT,
      workspaceRoot: null,
      profile: null,
    });
    expect(first.kind).toBe("published");

    const subscribe = createManualFileChangeSubscriber();
    const watcher = createConfigurationReloadWatcher({
      loader,
      loadRequest: { configurationRoot: CONFIG_ROOT, workspaceRoot: null, profile: null },
      watchedPaths: [localPath(USER_FILE)],
      clock: createManualClock(),
      coalesceMs: 1,
      subscribe,
      onReload: () => {},
    });

    await fileSystem.writeBytes(
      localPath(USER_FILE),
      new TextEncoder().encode(`{ "schemaVersion": 1, "diagnostics": { "level": "bogus" } }\n`),
    );
    subscribe.trigger();
    await new Promise((resolve) => setTimeout(resolve, 20));

    watcher.dispose();
    expect(loader.current()?.values["diagnostics.level"]).toBe("info");
  });
});
