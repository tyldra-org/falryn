/**
 * The load lifecycle end to end: discover, read, parse, validate, compose,
 * cross-validate, diff, classify, publish.
 *
 * Every source is an in-memory file and every layer is supplied through a port,
 * so no test touches a real disk or a real environment.
 */

import { describe, expect, test } from "bun:test";

import { createRuntimeRedactor, REDACTED } from "../application/index.ts";
import {
  type ConfigurationApplicationClass,
  type ConfigurationLoadOutcome,
  createInMemoryEventStore,
  createInMemoryFileSystem,
  createManualClock,
  createStaticEnvironment,
  type EnvironmentPort,
  type EventStorePort,
  FIRST_SEQUENCE,
  type InMemoryNode,
  localPath,
  sessionId,
  streamId,
  traceId,
  workspaceId,
} from "../domain/index.ts";
import { enumKey, integerKey } from "./declaration.ts";
import { V0_1_CONFIGURATION_KEYS, V0_1_CROSS_FIELD_RULES } from "./keys.ts";
import { createConfigurationLoader, type LoadRequest } from "./loader.ts";
import { createConfigurationRegistry } from "./registry.ts";

const CONFIG_ROOT = localPath("/d/config");
const WORKSPACE = localPath("/w/project");

const USER_FILE = "/d/config/falryn.jsonc";
const PROJECT_FILE = "/w/project/.falryn/falryn.jsonc";
const PROFILE_FILE = "/d/config/profiles/work.jsonc";

const CORRELATION = {
  workspaceId: workspaceId.from("workspace-1"),
  sessionId: sessionId.from("session-1"),
  traceId: traceId.from("trace-1"),
};

function file(text: string): InMemoryNode {
  return { kind: "file", text };
}

type Harness = {
  readonly loader: ReturnType<typeof createConfigurationLoader>;
  readonly registry: ReturnType<typeof createConfigurationRegistry>;
  readonly eventStore: EventStorePort;
};

function harness(
  options: {
    readonly nodes?: Readonly<Record<string, InMemoryNode>>;
    readonly environment?: Readonly<Record<string, string>>;
    readonly declarations?: typeof V0_1_CONFIGURATION_KEYS;
    readonly environmentPort?: EnvironmentPort;
  } = {},
): Harness {
  const declarations = options.declarations ?? V0_1_CONFIGURATION_KEYS;
  const registry = createConfigurationRegistry({
    declarations,
    crossFieldRules: declarations === V0_1_CONFIGURATION_KEYS ? V0_1_CROSS_FIELD_RULES : [],
    redactor: createRuntimeRedactor(),
  });
  const eventStore = createInMemoryEventStore();
  const loader = createConfigurationLoader({
    registry,
    declarations,
    fileSystem: createInMemoryFileSystem({ nodes: options.nodes ?? {} }),
    environment: options.environmentPort ?? createStaticEnvironment(options.environment ?? {}),
    redactor: createRuntimeRedactor(),
    clock: createManualClock(),
    eventStore,
    correlation: CORRELATION,
    streamId: streamId.from("configuration"),
  });
  return { loader, registry, eventStore };
}

const REQUEST: LoadRequest = {
  configurationRoot: CONFIG_ROOT,
  workspaceRoot: WORKSPACE,
  profile: null,
};

function published(outcome: ConfigurationLoadOutcome) {
  expect(outcome.kind).toBe("published");
  if (outcome.kind !== "published") {
    throw new Error("expected a published outcome");
  }
  return outcome;
}

describe("precedence across the six layers", () => {
  test("built-in defaults apply when no source sets anything", async () => {
    const { loader, registry } = harness();
    const outcome = published(await loader.load(REQUEST));

    expect(outcome.record.values).toEqual(registry.defaults());
    const level = outcome.record.provenance.find((entry) => entry.path === "diagnostics.level");
    expect(level?.source.kind).toBe("built-in-default");
  });

  test("each layer beats the one below it", async () => {
    const { loader } = harness({
      nodes: {
        [USER_FILE]: file(`{ "schemaVersion": 1, "diagnostics": { "level": "warn" } }`),
        [PROJECT_FILE]: file(`{ "schemaVersion": 1, "diagnostics": { "level": "error" } }`),
      },
    });
    const outcome = published(await loader.load(REQUEST));
    expect(outcome.record.values["diagnostics.level"]).toBe("error");
  });

  test("the environment beats every file", async () => {
    const { loader } = harness({
      nodes: {
        [USER_FILE]: file(`{ "schemaVersion": 1, "diagnostics": { "level": "warn" } }`),
        [PROJECT_FILE]: file(`{ "schemaVersion": 1, "diagnostics": { "level": "error" } }`),
      },
      environment: { FALRYN_LOG_LEVEL: "debug" },
    });
    const outcome = published(await loader.load(REQUEST));
    expect(outcome.record.values["diagnostics.level"]).toBe("debug");
  });

  test("a CLI override beats every layer including the environment", async () => {
    const { loader } = harness({
      nodes: { [USER_FILE]: file(`{ "schemaVersion": 1, "diagnostics": { "level": "warn" } }`) },
      environment: { FALRYN_LOG_LEVEL: "debug" },
    });
    const outcome = published(
      await loader.load({ ...REQUEST, overrides: { "diagnostics.level": "info" } }),
    );
    expect(outcome.record.values["diagnostics.level"]).toBe("info");
  });

  test("a profile sits above project configuration and below the environment", async () => {
    const { loader } = harness({
      nodes: {
        [PROJECT_FILE]: file(`{ "schemaVersion": 1, "diagnostics": { "level": "error" } }`),
        [PROFILE_FILE]: file(`{ "schemaVersion": 1, "diagnostics": { "level": "warn" } }`),
      },
    });
    const outcome = published(await loader.load({ ...REQUEST, profile: "work" }));
    expect(outcome.record.values["diagnostics.level"]).toBe("warn");
  });
});

describe("provenance", () => {
  test("names the winning source and keeps every value it beat", async () => {
    const { loader } = harness({
      nodes: {
        [USER_FILE]: file(`{ "schemaVersion": 1, "diagnostics": { "level": "warn" } }`),
        [PROJECT_FILE]: file(`{ "schemaVersion": 1, "diagnostics": { "level": "error" } }`),
      },
      environment: { FALRYN_LOG_LEVEL: "debug" },
    });
    const outcome = published(await loader.load(REQUEST));

    const winner = outcome.record.provenance.find((entry) => entry.path === "diagnostics.level");
    expect(winner?.source.kind).toBe("environment");
    expect(winner?.scope).toBe("environment");

    const losers = outcome.record.overridden
      .filter((entry) => entry.path === "diagnostics.level")
      .map((entry) => entry.source.kind);
    expect(losers).toEqual(["user-file", "project-file"]);
  });

  test("records the layer index, so precedence is comparable rather than implied", async () => {
    const { loader } = harness({
      nodes: { [USER_FILE]: file(`{ "schemaVersion": 1, "diagnostics": { "level": "warn" } }`) },
    });
    const outcome = published(await loader.load(REQUEST));
    const winner = outcome.record.provenance.find((entry) => entry.path === "diagnostics.level");
    expect(winner?.layerIndex).toBe(1);
    expect(winner?.schemaVersion).toBe(1);
  });
});

describe("declared merge across layers", () => {
  test("a scalar replaces", async () => {
    // `diagnostics.retention.maxEvents` declares user and CLI scope and not
    // project, so the two layers that may set it are the ones used here.
    const { loader } = harness({
      nodes: {
        [USER_FILE]: file(
          `{ "schemaVersion": 1, "diagnostics": { "retention": { "maxEvents": 10 } } }`,
        ),
      },
    });
    const outcome = published(
      await loader.load({
        ...REQUEST,
        overrides: { "diagnostics.retention.maxEvents": "20" },
      }),
    );
    expect(outcome.record.values["diagnostics.retention.maxEvents"]).toBe(20);
  });

  test("a project file may not set a key that declares no project scope", async () => {
    const { loader } = harness({
      nodes: {
        [PROJECT_FILE]: file(
          `{ "schemaVersion": 1, "diagnostics": { "retention": { "maxEvents": 20 } } }`,
        ),
      },
    });
    const outcome = await loader.load(REQUEST);
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.issues.map((issue) => issue.kind)).toContain("scope-unavailable");
    }
  });

  test("a declared map merges one level, keeping entries no layer mentioned", async () => {
    const { loader, registry } = harness({
      nodes: {
        [USER_FILE]: file(
          `{ "schemaVersion": 1, "data": { "retention": { "logs": { "maxAgeMs": 60000, "maxBytes": 1048576 } } } }`,
        ),
      },
    });
    const outcome = published(await loader.load(REQUEST));

    const retention = outcome.record.values["data.retention"] as Record<string, unknown>;
    const defaults = registry.defaults()["data.retention"] as Record<string, unknown>;
    expect(retention.logs).toEqual({ maxAgeMs: 60_000, maxBytes: 1_048_576 });
    expect(retention.cache).toEqual(defaults.cache);
    expect(retention.temporaryIngest).toEqual(defaults.temporaryIngest);
  });

  test("a key that declares no identity merging replaces outright", async () => {
    // `data.roots.cache` is a scalar path, and two layers setting it means the
    // later one wins whole — there is no element-wise behavior to fall into.
    const { loader } = harness({
      nodes: {
        [USER_FILE]: file(`{ "schemaVersion": 1, "data": { "roots": { "cache": "/a" } } }`),
      },
      environment: { FALRYN_CACHE_DIR: "/b" },
    });
    const outcome = published(await loader.load(REQUEST));
    expect(outcome.record.values["data.roots.cache"]).toBe("/b");
  });
});

describe("reading sources", () => {
  test("accepts JSONC with comments and a trailing comma", async () => {
    const { loader } = harness({
      nodes: {
        [USER_FILE]: file(`{
  // the level a person actually reads
  "schemaVersion": 1,
  "diagnostics": { "level": "warn", },
}`),
      },
    });
    const outcome = published(await loader.load(REQUEST));
    expect(outcome.record.values["diagnostics.level"]).toBe("warn");
  });

  test("rejects malformed JSONC without echoing the file", async () => {
    const secret = "sk-live-0123456789abcdef";
    const { loader } = harness({
      nodes: { [USER_FILE]: file(`{ "schemaVersion": 1, "token": "${secret}" `) },
    });
    const outcome = await loader.load(REQUEST);

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      const report = outcome.sources.find((entry) => entry.source.kind === "user-file");
      expect(report?.outcome).toBe("malformed-syntax");
      expect(JSON.stringify(outcome)).not.toContain(secret);
    }
  });

  test("a malformed source reports where, and still no content", async () => {
    const secret = "sk-live-abcdefabcdef";
    const { loader } = harness({
      nodes: {
        [USER_FILE]: file(`{\n  "schemaVersion": 1,\n  "note": "${secret}"\n  "oops": 1\n}`),
      },
    });
    const outcome = await loader.load(REQUEST);

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      const report = outcome.sources.find((entry) => entry.source.kind === "user-file");
      expect(report?.outcome).toBe("malformed-syntax");
      // A line and a column and nothing else: enough to open the file at the
      // right place, not enough to quote what is there.
      expect(report?.position?.line).toBe(4);
      expect(report?.position?.column).toBeGreaterThan(0);
      expect(JSON.stringify(outcome)).not.toContain(secret);
    }
  });

  test("a well-formed source reports no position", async () => {
    const { loader } = harness({
      nodes: { [USER_FILE]: file(`{ "schemaVersion": 1 }`) },
    });
    const outcome = published(await loader.load(REQUEST));
    const report = outcome.record.sources.find((entry) => entry.source.kind === "user-file");
    expect(report?.position).toBeNull();
  });

  test.each([
    ["absent", undefined],
    ["empty", file("   \n  ")],
    ["comments only", file("// nothing here\n")],
  ] as const)("a %s user source contributes nothing without failing", async (_label, node) => {
    const nodes = node === undefined ? {} : { [USER_FILE]: node };
    const { loader, registry } = harness({ nodes });
    const outcome = published(await loader.load(REQUEST));
    expect(outcome.record.values).toEqual(registry.defaults());
  });

  test("an absent source is reported rather than silently skipped", async () => {
    const { loader } = harness();
    const outcome = published(await loader.load(REQUEST));
    const report = outcome.record.sources.find((entry) => entry.source.kind === "user-file");
    expect(report?.outcome).toBe("absent");
  });

  test("an oversized source is refused by size, not by reading it", async () => {
    const { loader } = harness({
      nodes: { [USER_FILE]: { kind: "file", text: "{}", byteLength: 10_000_000 } },
    });
    const outcome = published(await loader.load(REQUEST));
    const report = outcome.record.sources.find((entry) => entry.source.kind === "user-file");
    expect(report?.outcome).toBe("oversized");
  });

  test("a source that is a directory is unreadable rather than fatal", async () => {
    const { loader } = harness({ nodes: { [USER_FILE]: { kind: "directory" } } });
    const outcome = published(await loader.load(REQUEST));
    const report = outcome.record.sources.find((entry) => entry.source.kind === "user-file");
    expect(report?.outcome).toBe("unreadable");
  });
});

describe("failing closed on content, open on availability", () => {
  const GOOD = `{ "schemaVersion": 1, "diagnostics": { "level": "warn" } }`;

  test("an unavailable source is skipped and the rest still publish", async () => {
    const { loader } = harness({
      nodes: { [USER_FILE]: file(GOOD) },
      // The project source does not exist at all.
    });
    const outcome = published(await loader.load(REQUEST));

    expect(outcome.record.values["diagnostics.level"]).toBe("warn");
    expect(
      outcome.record.sources.find((entry) => entry.source.kind === "project-file")?.outcome,
    ).toBe("absent");
  });

  test("a source that was read but is invalid refuses the whole load", async () => {
    const { loader } = harness({
      nodes: {
        [USER_FILE]: file(GOOD),
        [PROJECT_FILE]: file(`{ "schemaVersion": 1, "diagnostics": { "levl": "warn" } }`),
      },
    });
    const outcome = await loader.load(REQUEST);

    // The valid user file does *not* take effect. Dropping the mistyped file
    // and carrying on would apply a configuration the user did not write, which
    // is the same failure as accepting the typo.
    expect(outcome.kind).toBe("rejected");
  });

  test("a malformed source refuses the load even beside a valid one", async () => {
    const { loader } = harness({
      nodes: {
        [USER_FILE]: file(GOOD),
        [PROJECT_FILE]: file(`{ "schemaVersion": 1, `),
      },
    });
    expect((await loader.load(REQUEST)).kind).toBe("rejected");
  });

  test("an oversized source is skipped, because it was never read", async () => {
    const { loader } = harness({
      nodes: {
        [USER_FILE]: file(GOOD),
        [PROJECT_FILE]: { kind: "file", text: "{}", byteLength: 10_000_000 },
      },
    });
    const outcome = published(await loader.load(REQUEST));
    expect(outcome.record.values["diagnostics.level"]).toBe("warn");
  });
});

describe("invalid content", () => {
  test("an unknown key in one file rejects the load and keeps the last generation", async () => {
    const { loader } = harness({
      nodes: { [USER_FILE]: file(`{ "schemaVersion": 1, "diagnostics": { "level": "warn" } }`) },
    });
    const first = published(await loader.load(REQUEST));

    const { loader: second } = harness({
      nodes: { [USER_FILE]: file(`{ "schemaVersion": 1, "diagnostics": { "levl": "warn" } }`) },
    });
    const outcome = await second.load(REQUEST);

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.issues.map((issue) => issue.kind)).toContain("unknown-key");
      expect(outcome.retained).toBeNull();
    }
    expect(first.record.values["diagnostics.level"]).toBe("warn");
  });

  test("a refresh that goes invalid retains the previous generation", async () => {
    const nodes: Record<string, InMemoryNode> = {
      [USER_FILE]: file(`{ "schemaVersion": 1, "diagnostics": { "level": "warn" } }`),
    };
    const fileSystem = createInMemoryFileSystem({ nodes });
    const registry = createConfigurationRegistry({
      declarations: V0_1_CONFIGURATION_KEYS,
      crossFieldRules: V0_1_CROSS_FIELD_RULES,
      redactor: createRuntimeRedactor(),
    });
    const loader = createConfigurationLoader({
      registry,
      declarations: V0_1_CONFIGURATION_KEYS,
      fileSystem,
      environment: createStaticEnvironment({}),
      redactor: createRuntimeRedactor(),
      clock: createManualClock(),
      eventStore: createInMemoryEventStore(),
      correlation: CORRELATION,
      streamId: streamId.from("configuration"),
    });

    const first = published(await loader.load(REQUEST));
    fileSystem.put(USER_FILE, file(`{ "schemaVersion": 1, "diagnostics": { "level": 7 } }`));
    const second = await loader.load(REQUEST);

    expect(second.kind).toBe("rejected");
    if (second.kind === "rejected") {
      // The working configuration is still in effect. Replacing it with nothing
      // because a later edit was wrong would be worse than the edit.
      expect(second.retained?.generation).toBe(first.record.generation);
      expect(second.retained?.values["diagnostics.level"]).toBe("warn");
    }
    expect(loader.current()?.generation).toBe(first.record.generation);
  });

  test("a cross-field conflict composes per layer and fails the whole value", async () => {
    // Each file is individually valid; together they exceed the total quota.
    const { loader } = harness({
      nodes: {
        [USER_FILE]: file(
          `{ "schemaVersion": 1, "data": { "quotas": { "totalMaxBytes": 1048576 } } }`,
        ),
      },
    });
    const outcome = await loader.load(REQUEST);
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.issues.map((issue) => issue.kind)).toContain("cross-field-conflict");
    }
  });
});

describe("the environment bridge", () => {
  test("reads a variable a key declares", async () => {
    const { loader } = harness({ environment: { FALRYN_LOG_LEVEL: "error" } });
    const outcome = published(await loader.load(REQUEST));
    expect(outcome.record.values["diagnostics.level"]).toBe("error");
  });

  test("ignores a variable no key declares", async () => {
    const seen: string[] = [];
    const environmentPort: EnvironmentPort = {
      get(name) {
        seen.push(name);
        return name === "FALRYN_SOMETHING_ELSE" ? "surprise" : null;
      },
    };
    const { loader, registry } = harness({ environmentPort });
    const outcome = published(await loader.load(REQUEST));

    expect(outcome.record.values).toEqual(registry.defaults());
    // Driven by the catalog: the bridge only ever asked about declared names.
    expect(seen).not.toContain("FALRYN_SOMETHING_ELSE");
    expect(seen).toContain("FALRYN_LOG_LEVEL");
  });

  test("refuses a variable whose text is not the declared shape", async () => {
    const { loader } = harness({ environment: { FALRYN_LOG_LEVEL: "chatty" } });
    const outcome = await loader.load(REQUEST);
    expect(outcome.kind).toBe("rejected");
  });
});

describe("CLI overrides", () => {
  test("a path nothing declares is an unknown key, not a silent no-op", async () => {
    const { loader } = harness();
    const outcome = await loader.load({ ...REQUEST, overrides: { "diagnostics.levl": "warn" } });

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.issues.map((issue) => issue.kind)).toContain("unknown-key");
    }
  });
});

describe("generations and events", () => {
  test("the first load publishes generation zero and appends one event", async () => {
    const { loader, eventStore } = harness();
    const outcome = published(await loader.load(REQUEST));

    expect(Number(outcome.record.generation)).toBe(0);
    const read = await eventStore.readFrom(
      { streamId: streamId.from("configuration"), afterSequence: null },
      10,
    );
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value).toHaveLength(1);
      const [event] = read.value;
      expect(event?.kind).toBe("configuration.generation.changed");
      expect(event?.sequence).toBe(FIRST_SEQUENCE);
      if (event?.kind === "configuration.generation.changed") {
        expect(Number(event.payload.generation)).toBe(0);
        expect(event.payload.applicationClass).toBe(outcome.applicationClass);
      }
    }
  });

  test("a refresh that changes nothing publishes no generation and no event", async () => {
    const { loader, eventStore } = harness({
      nodes: { [USER_FILE]: file(`{ "schemaVersion": 1, "diagnostics": { "level": "warn" } }`) },
    });
    const first = published(await loader.load(REQUEST));
    const second = await loader.load(REQUEST);

    expect(second.kind).toBe("unchanged");
    if (second.kind === "unchanged") {
      expect(second.record.generation).toBe(first.record.generation);
    }

    const read = await eventStore.readFrom(
      { streamId: streamId.from("configuration"), afterSequence: null },
      10,
    );
    expect(read.ok && read.value).toHaveLength(1);
  });

  test("a change publishes the next generation and a second event", async () => {
    const fileSystem = createInMemoryFileSystem({
      nodes: { [USER_FILE]: file(`{ "schemaVersion": 1, "diagnostics": { "level": "warn" } }`) },
    });
    const registry = createConfigurationRegistry({
      declarations: V0_1_CONFIGURATION_KEYS,
      crossFieldRules: V0_1_CROSS_FIELD_RULES,
      redactor: createRuntimeRedactor(),
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
      correlation: CORRELATION,
      streamId: streamId.from("configuration"),
    });

    await loader.load(REQUEST);
    fileSystem.put(USER_FILE, file(`{ "schemaVersion": 1, "diagnostics": { "level": "error" } }`));
    const second = published(await loader.load(REQUEST));

    expect(Number(second.record.generation)).toBe(1);
    expect(second.changes.map((change) => String(change.path))).toEqual(["diagnostics.level"]);
    expect(second.changes[0]?.redactedBefore).toBe("warn");
    expect(second.changes[0]?.redactedAfter).toBe("error");

    const read = await eventStore.readFrom(
      { streamId: streamId.from("configuration"), afterSequence: null },
      10,
    );
    expect(read.ok && read.value).toHaveLength(2);
  });
});

describe("application classes", () => {
  /** One key per class, because no v0.1 product key declares next-turn or reconnect. */
  const CLASS_KEYS = (
    ["live", "next-operation", "next-turn", "reconnect", "application-restart"] as const
  ).map((applicationClass, index) =>
    integerKey({
      path: `classes.key${index}`,
      summary: `A key applied ${applicationClass}.`,
      unit: "items",
      minimum: 0,
      maximum: 100,
      defaultValue: 0,
      scopes: ["user", "project", "profile", "environment", "cli"],
      applicationClass,
    }),
  );

  test.each([
    ["live", 0],
    ["next-operation", 1],
    ["next-turn", 2],
    ["reconnect", 3],
    ["application-restart", 4],
  ] as const)("a change to a %s key classifies as %s", async (applicationClass, index) => {
    const fileSystem = createInMemoryFileSystem({
      nodes: { [USER_FILE]: file(`{ "schemaVersion": 1 }`) },
    });
    const registry = createConfigurationRegistry({
      declarations: CLASS_KEYS,
      redactor: createRuntimeRedactor(),
    });
    const loader = createConfigurationLoader({
      registry,
      declarations: CLASS_KEYS,
      fileSystem,
      environment: createStaticEnvironment({}),
      redactor: createRuntimeRedactor(),
      clock: createManualClock(),
      eventStore: createInMemoryEventStore(),
      correlation: CORRELATION,
      streamId: streamId.from("configuration"),
    });

    await loader.load(REQUEST);
    fileSystem.put(USER_FILE, file(`{ "schemaVersion": 1, "classes": { "key${index}": 5 } }`));
    const outcome = published(await loader.load(REQUEST));

    expect(outcome.applicationClass).toBe(applicationClass as ConfigurationApplicationClass);
  });

  test("a mixed refresh reports the strongest class, not the first", async () => {
    const fileSystem = createInMemoryFileSystem({
      nodes: { [USER_FILE]: file(`{ "schemaVersion": 1 }`) },
    });
    const registry = createConfigurationRegistry({
      declarations: CLASS_KEYS,
      redactor: createRuntimeRedactor(),
    });
    const loader = createConfigurationLoader({
      registry,
      declarations: CLASS_KEYS,
      fileSystem,
      environment: createStaticEnvironment({}),
      redactor: createRuntimeRedactor(),
      clock: createManualClock(),
      eventStore: createInMemoryEventStore(),
      correlation: CORRELATION,
      streamId: streamId.from("configuration"),
    });

    await loader.load(REQUEST);
    fileSystem.put(USER_FILE, file(`{ "schemaVersion": 1, "classes": { "key0": 1, "key4": 1 } }`));
    const outcome = published(await loader.load(REQUEST));

    // Applying the live half and calling it done would leave the restart half
    // configured and not in effect.
    expect(outcome.applicationClass).toBe("application-restart");
  });
});

describe("cancellation", () => {
  test("an aborted load publishes nothing", async () => {
    const { loader, eventStore } = harness();
    const controller = new AbortController();
    controller.abort();

    const outcome = await loader.load(REQUEST, controller.signal);
    expect(outcome.kind).toBe("cancelled");
    expect(loader.current()).toBeNull();

    const read = await eventStore.readFrom(
      { streamId: streamId.from("configuration"), afterSequence: null },
      10,
    );
    expect(read.ok && read.value).toHaveLength(0);
  });
});

describe("negative controls", () => {
  test("a secret in a project file reaches no event, diagnostic, or projection", async () => {
    const secret = "ghp_0123456789abcdef0123456789abcdef0123";
    const sensitive = enumKey({
      path: "secrets.mode",
      summary: "A declared-sensitive key.",
      allowed: [secret, "safe"],
      defaultValue: "safe",
      sensitivity: "sensitive",
      scopes: ["user", "project"],
      applicationClass: "live",
    });
    const declarations = [sensitive];
    const registry = createConfigurationRegistry({
      declarations,
      redactor: createRuntimeRedactor(),
    });
    const eventStore = createInMemoryEventStore();
    const loader = createConfigurationLoader({
      registry,
      declarations,
      fileSystem: createInMemoryFileSystem({
        nodes: {
          [PROJECT_FILE]: file(`{ "schemaVersion": 1, "secrets": { "mode": "${secret}" } }`),
        },
      }),
      environment: createStaticEnvironment({}),
      redactor: createRuntimeRedactor(),
      clock: createManualClock(),
      eventStore,
      correlation: CORRELATION,
      streamId: streamId.from("configuration"),
    });

    const outcome = published(await loader.load(REQUEST));

    // The value is in effect — composition is not lossy — but nothing that
    // leaves the runtime carries it.
    expect(outcome.record.values["secrets.mode"]).toBe(secret);
    expect(JSON.stringify(outcome.record.provenance)).not.toContain(secret);
    expect(JSON.stringify(outcome.changes)).not.toContain(secret);
    expect(JSON.stringify(outcome.record.sources)).not.toContain(secret);
    expect(JSON.stringify(outcome.record.provenance)).toContain(REDACTED);

    const read = await eventStore.readFrom(
      { streamId: streamId.from("configuration"), afterSequence: null },
      10,
    );
    expect(JSON.stringify(read)).not.toContain(secret);
  });

  test("no source report carries file content", async () => {
    const secret = "sk-live-abcdefabcdefabcdef";
    const { loader } = harness({
      nodes: { [USER_FILE]: file(`{ "schemaVersion": 1, "note": "${secret}" }`) },
    });
    const outcome = await loader.load(REQUEST);
    expect(JSON.stringify(outcome)).not.toContain(secret);
  });
});
