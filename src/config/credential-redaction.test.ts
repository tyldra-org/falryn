/**
 * The redaction sweep.
 *
 * A credential reference and a secret-shaped public value are loaded through
 * the real six-layer lifecycle, and then every projection that lifecycle
 * produces is searched for the bytes that went in: the inspection projection,
 * the `configuration.generation.changed` event, the source reports, the
 * provenance, and the diagnostics the run recorded.
 *
 * This is one redactor's behavior observed at four boundaries, not a second set
 * of rules. It exists because the guarantee that matters is "no surface can
 * forget", and the only way to hold that is to check every surface.
 */

import { describe, expect, test } from "bun:test";

import {
  containsRedactableSecret,
  createDiagnosticsCollector,
  createRuntimeRedactor,
  REDACTED,
} from "../application/index.ts";
import {
  type ConfigurationLoadOutcome,
  createInMemoryEventStore,
  createInMemoryFileSystem,
  createManualClock,
  createStaticEnvironment,
  type InMemoryNode,
  localPath,
  sessionId,
  streamId,
  traceId,
  workspaceId,
} from "../domain/index.ts";
import { credentialReferenceKey, integerKey, pathOverrideKey } from "./declaration.ts";
import { inspectGeneration } from "./inspection.ts";
import { createConfigurationLoader } from "./loader.ts";
import { createConfigurationRegistry } from "./registry.ts";

const SECRET = "sk-live-0123456789abcdefghij";
const LOCATOR = "falryn-example-provider";
const CONFIG_ROOT = localPath("/d/config");
const USER_FILE = "/d/config/falryn.jsonc";

const DECLARATIONS = [
  credentialReferenceKey({
    path: "provider.credential",
    summary: "A credential reference for a provider.",
    scopes: ["user", "profile", "environment"],
    applicationClass: "next-turn",
  }),
  integerKey({
    path: "provider.retries",
    summary: "A public value beside the credential.",
    unit: "items",
    minimum: 0,
    maximum: 10,
    defaultValue: 3,
    scopes: ["user"],
    applicationClass: "live",
  }),
  // A public string is where a credential someone typed into the wrong field
  // ends up, so the sweep needs one to check.
  pathOverrideKey({
    path: "provider.endpoint",
    summary: "A public endpoint whose text still passes through the redactor.",
    maxLength: 512,
    scopes: ["user"],
    applicationClass: "next-turn",
  }),
];

function file(text: string): InMemoryNode {
  return { kind: "file", text };
}

async function load(document: string): Promise<{
  readonly outcome: ConfigurationLoadOutcome;
  readonly registry: ReturnType<typeof createConfigurationRegistry>;
  readonly events: ReturnType<typeof createInMemoryEventStore>;
}> {
  const registry = createConfigurationRegistry({
    declarations: DECLARATIONS,
    redactor: createRuntimeRedactor(),
  });
  const events = createInMemoryEventStore();
  const loader = createConfigurationLoader({
    registry,
    declarations: DECLARATIONS,
    fileSystem: createInMemoryFileSystem({ nodes: { [USER_FILE]: file(document) } }),
    environment: createStaticEnvironment({}),
    redactor: createRuntimeRedactor(),
    clock: createManualClock(),
    eventStore: events,
    correlation: {
      workspaceId: workspaceId.from("workspace-1"),
      sessionId: sessionId.from("session-1"),
      traceId: traceId.from("trace-1"),
    },
    streamId: streamId.from("configuration"),
  });

  const outcome = await loader.load({
    configurationRoot: CONFIG_ROOT,
    workspaceRoot: null,
    profile: null,
  });
  return { outcome, registry, events };
}

const REFERENCE_DOCUMENT = JSON.stringify({
  schemaVersion: 1,
  provider: {
    credential: {
      storeKind: "operating-system-keychain",
      locator: LOCATOR,
      consumer: "example-provider",
      accountLabel: "work@example.com",
    },
    retries: 5,
  },
});

describe("a configured credential reference", () => {
  test("publishes, and its locator appears in no projection", async () => {
    const { outcome, registry, events } = await load(REFERENCE_DOCUMENT);
    expect(outcome.kind).toBe("published");
    if (outcome.kind !== "published") {
      throw new Error("expected a published outcome");
    }

    const inspection = inspectGeneration(registry, outcome.record);
    const read = await events.readFrom(
      { streamId: streamId.from("configuration"), afterSequence: null },
      10,
    );

    const sweep = JSON.stringify({
      inspection,
      // The generation event, exactly as a consumer would receive it.
      events: read.ok ? read.value : read,
      sources: outcome.record.sources,
      provenance: outcome.record.provenance,
      overridden: outcome.record.overridden,
      changes: outcome.changes,
    });

    expect(sweep).not.toContain(LOCATOR);
  });

  test("inspection shows presence, store kind, and consumer", async () => {
    const { outcome, registry } = await load(REFERENCE_DOCUMENT);
    if (outcome.kind !== "published") {
      throw new Error("expected a published outcome");
    }

    const inspection = inspectGeneration(registry, outcome.record);
    const credential = inspection.values.find((value) => value.path === "provider.credential");
    expect(credential?.value).toEqual({
      storeKind: "operating-system-keychain",
      consumer: "example-provider",
      accountLabel: "work@example.com",
      locator: REDACTED,
      present: true,
    });
  });

  test("the generation event carries a generation and a class, and nothing else", async () => {
    const { outcome, events } = await load(REFERENCE_DOCUMENT);
    if (outcome.kind !== "published") {
      throw new Error("expected a published outcome");
    }

    const read = await events.readFrom(
      { streamId: streamId.from("configuration"), afterSequence: null },
      10,
    );
    expect(read.ok).toBe(true);
    if (!read.ok) {
      throw new Error("expected a readable stream");
    }
    const [event] = read.value;
    expect(event?.kind).toBe("configuration.generation.changed");
    // A payload that named the keys that changed would name a credential key,
    // and a payload that carried their values would carry the reference.
    expect(Object.keys(event?.payload ?? {}).sort()).toEqual(["applicationClass", "generation"]);
  });
});

describe("a secret typed into a public value", () => {
  const url = `https://user:${SECRET}@provider.example.com/v1`;

  test("the redactor catches it in the effective value and in its provenance", async () => {
    expect(containsRedactableSecret(url)).toBe(true);

    const { outcome, registry } = await load(
      JSON.stringify({ schemaVersion: 1, provider: { credential: null, endpoint: url } }),
    );
    expect(outcome.kind).toBe("published");
    if (outcome.kind !== "published") {
      throw new Error("expected a published outcome");
    }

    // The value is public and is still not shown as written: a credential-bearing
    // URL keeps its shape and loses its credential, at both boundaries.
    const inspection = inspectGeneration(registry, outcome.record);
    const endpoint = inspection.values.find((value) => value.path === "provider.endpoint");
    expect(endpoint?.value).toBe(`https://${REDACTED}@provider.example.com/v1`);

    const sweep = JSON.stringify({
      inspection,
      provenance: outcome.record.provenance,
      changes: outcome.changes,
    });
    expect(sweep).not.toContain(SECRET);
  });
});

describe("a plaintext credential in a user file", () => {
  test("refuses the whole load and never publishes the value", async () => {
    const { outcome, events } = await load(
      JSON.stringify({ schemaVersion: 1, provider: { credential: SECRET } }),
    );

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") {
      throw new Error("expected a rejected outcome");
    }
    expect(outcome.issues.some((issue) => issue.kind === "plaintext-credential")).toBe(true);
    expect(JSON.stringify(outcome)).not.toContain("sk-live");

    // Nothing was published, so no consumer was told about it either.
    const read = await events.readFrom(
      { streamId: streamId.from("configuration"), afterSequence: null },
      10,
    );
    expect(read.ok && read.value.length).toBe(0);
  });
});

describe("the diagnostics buffer", () => {
  test("a credential-shaped value in metadata is replaced wholesale", async () => {
    const collector = createDiagnosticsCollector({ clock: createManualClock() });
    collector.emit({
      level: "warn",
      subsystem: "credentials",
      code: "credential.denied",
      metadata: { storeKind: "operating-system-keychain", apiKey: SECRET, note: SECRET },
    });

    const sweep = JSON.stringify(collector.events());
    expect(sweep).not.toContain(SECRET);
    expect(sweep).not.toContain("sk-live");
    expect(collector.events()[0]?.metadata.apiKey).toBe(REDACTED);
  });
});
