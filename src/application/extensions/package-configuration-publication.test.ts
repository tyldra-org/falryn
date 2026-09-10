import { afterEach, expect, test } from "bun:test";
import { createConfigurationLoader } from "../../config/resolution/loader.ts";
import {
  bindPackageConfiguration,
  packageConfigurationKeys,
  packageConfigurationPrefix,
} from "../../config/resolution/package-configuration.ts";
import { createConfigurationRegistry } from "../../config/resolution/registry.ts";
import { removeTemporaryRoots } from "../../data/fixtures.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import {
  createManualClock,
  createStaticEnvironment,
  sessionId,
  streamId,
  traceId,
  workspaceId,
} from "../../domain/foundation/index.ts";
import { createInMemoryEventStore } from "../../domain/sessions/index.ts";
import { createInMemoryFileSystem, localPath } from "../../domain/workspace/index.ts";
import { createRuntimeRedactor } from "../diagnostics/redaction.ts";
import { packageDataFixture, setting } from "./package-data.fixtures.ts";
import { validatePackageSetting } from "./package-data-policy.ts";
import { createPackageDataProtocol } from "./package-data-protocol.ts";

afterEach(removeTemporaryRoots);
test("normal file, profile, environment and CLI precedence supplies an immutable narrow supervised snapshot", async () => {
  const fixture = await packageDataFixture();
  try {
    const prefix = packageConfigurationPrefix("fixture");
    const key = `${prefix}.display.label`;
    const declarations = packageConfigurationKeys({
      packageId: "fixture",
      declarations: [setting],
      allowedScopes: setting.scopes,
      validateSensitive: validatePackageSetting,
    });
    const environmentKey = declarations[0]?.descriptor.environmentVariable;
    if (!environmentKey) throw new Error("missing bridge");
    const text = (value: string) =>
      JSON.stringify({
        schemaVersion: 1,
        packages: { [prefix.slice(9)]: { display: { label: value } } },
      });
    const files = createInMemoryFileSystem({
      nodes: {
        "/config/falryn.jsonc": { kind: "file", text: text("user") },
        "/workspace/.falryn/falryn.jsonc": { kind: "file", text: text("project") },
        "/config/profiles/work.jsonc": { kind: "file", text: text("profile") },
      },
    });
    const registry = createConfigurationRegistry({
      declarations,
      redactor: createRuntimeRedactor(),
    });
    const loader = createConfigurationLoader({
      registry,
      declarations,
      fileSystem: files,
      environment: createStaticEnvironment({
        [environmentKey]: "environment",
        UNDECLARED_SECRET: "must-not-cross",
      }),
      redactor: createRuntimeRedactor(),
      clock: createManualClock(),
      eventStore: createInMemoryEventStore(),
      streamId: streamId.from("config"),
      correlation: {
        workspaceId: workspaceId.from("workspace"),
        sessionId: sessionId.from("session"),
        traceId: traceId.from("trace"),
      },
    });
    const request = {
      configurationRoot: localPath("/config"),
      workspaceRoot: localPath("/workspace"),
      profile: "work",
      overrides: { [key]: "cli" },
    };
    const loaded = await loader.load(request);
    if (loaded.kind !== "published") throw new Error(JSON.stringify(loaded));
    expect(loaded.record.values[key]).toBe("cli");
    expect(loaded.record.overridden.map((source) => source.source.kind)).toEqual(
      expect.arrayContaining(["user-file", "project-file", "profile", "environment"]),
    );
    const document = fixture.data.read("fixture");
    if (!document.ok || !document.value) throw new Error("missing document");
    const binding = {
      version: 1 as const,
      packageId: "fixture",
      packageDigest: document.value.packageDigest,
      packageVersion: "1.0.0",
      contribution: null,
      packageRevision: 1,
      configurationGeneration: loaded.record.generation,
      catalogGeneration: "catalog",
      workspaceGeneration: "workspace",
      sessionGeneration: null,
      protocolGeneration: "1",
      authority: canonicalDigest("authority"),
    };
    const snapshot = bindPackageConfiguration(loaded.record, binding, [setting]);
    const protocol = createPackageDataProtocol({
      store: fixture.data,
      configurationSnapshot: snapshot,
      authority: {
        binding,
        configurationRevision: 1,
        hostControl: false,
        current: () => true,
        allows: () => true,
      },
      now: () => 1000,
    });
    expect(protocol.receive({ version: 1, operation: "configuration", binding })).toMatchObject({
      status: "configuration",
      snapshot: { values: { "display.label": "cli" } },
    });
    expect(JSON.stringify(snapshot)).not.toContain("must-not-cross");
    const invalid = await loader.load({ ...request, overrides: { [key]: "x".repeat(33) } });
    expect(invalid).toMatchObject({
      kind: "rejected",
      retained: { generation: loaded.record.generation, values: { [key]: "cli" } },
    });
    expect(await loader.load(request)).toMatchObject({ kind: "unchanged" });
    const narrowed = await loader.load({ ...request, projectText: null, overrides: {} });
    expect(narrowed.kind).toBe("published");
    if (narrowed.kind === "published") {
      expect(narrowed.record.values[key]).toBe("environment");
      expect(
        narrowed.record.overridden.some((source) => source.source.kind === "project-file"),
      ).toBe(false);
    }
    expect(protocol.receive({ version: 1, operation: "configuration", binding })).toMatchObject({
      status: "configuration",
      snapshot: { values: { "display.label": "cli" } },
    });
  } finally {
    await fixture.store.close();
  }
});

test("different key spellings cannot register the same environment variable", () => {
  expect(() =>
    packageConfigurationKeys({
      packageId: "fixture",
      declarations: [
        { ...setting, id: "fooBar" },
        { ...setting, id: "foobar" },
      ],
      allowedScopes: setting.scopes,
      validateSensitive: validatePackageSetting,
    }),
  ).toThrow("duplicate-package-environment-bridge");
});
