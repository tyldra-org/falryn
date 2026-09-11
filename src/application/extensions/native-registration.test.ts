import { expect, test } from "bun:test";
import { z } from "zod";
import { bytesDigest } from "../../domain/extensions/canonical.ts";
import {
  type CatalogEntry,
  catalogEntryKey,
  createExtensionCatalog,
} from "../../domain/extensions/catalog.ts";
import { catalogFixture } from "../../domain/extensions/catalog-fixtures.ts";
import { resolveExtensionCatalog } from "../../domain/extensions/catalog-resolution.ts";
import type { NativeActivation } from "../../domain/extensions/native-activation.ts";
import { PACKAGE_TOOL_PROTOCOL } from "../../domain/extensions/package-health.ts";
import { configurationGeneration } from "../../domain/foundation/index.ts";
import { isClosedProductToolSchema } from "../tools/product-tool-schema.ts";
import {
  createNativeRegistrationPublisher,
  type NativeRegistrationOwner,
} from "./native-registration.ts";
import { createNativeToolOwner } from "./native-tool-owner.ts";
import {
  executionResources,
  inspectionHost,
  packageSource,
  pluginManifest,
} from "./package-fixtures.ts";
import { preparePackage } from "./prepare-package.ts";

async function fixture(dependency = false) {
  const schema = {
    type: "object",
    properties: { answer: { type: "integer" } },
    required: ["answer"],
    additionalProperties: false,
  };
  const prepared = await preparePackage(
    packageSource(
      pluginManifest({
        version: 1,
        contributions: ["good", "disabled"].map((id) => ({
          kind: "tool",
          namespace: "fixture",
          id,
          description: "Read the fixture answer",
          ...(dependency && id === "good" ? { dependencies: ["disabled"] } : {}),
          family: "read",
          inputSchema: schema,
          outputSchema: schema,
          authority: {
            effects: ["observation"],
            permissions: [],
            roots: [],
            destinations: [],
            secretReferences: [],
            localData: [],
          },
          execution: {
            mode: "governed",
            executable: "peer",
            loader: "native",
            protocolVersion: PACKAGE_TOOL_PROTOCOL,
            compatibility: {},
            resources: executionResources,
          },
        })),
        files: [{ path: "peer", digest: bytesDigest("inert fixture") }],
      }),
      {
        peer: "inert fixture",
        "skills/one/SKILL.md":
          "---\nname: one\ndescription: Never disclose this body\n---\nPRIVATE-BODY",
      },
    ),
    inspectionHost,
  );
  if (!prepared.ok) throw new Error(prepared.code);
  const template = catalogFixture();
  if (template.source.kind !== "package") throw new Error("fixture source");
  const entries: CatalogEntry[] = prepared.package.contributions.map((contribution) => ({
    ...template,
    source: {
      kind: "package",
      owner: prepared.package.identity,
      activation: {
        version: 1,
        packageIdentityDigest: prepared.package.identityDigest,
        scope: "user",
        scopeAuthorityId: bytesDigest("scope"),
        scopeAuthorityGeneration: 1,
        configurationGeneration: 1,
        activationRevision: 1,
        catalogGeneration: 1,
      },
    },
    contribution: contribution.identity,
    family: contribution.family ?? null,
    effects: contribution.authority.effects,
    aliases: [contribution.identity.localId],
    enabled: contribution.identity.localId !== "disabled",
  }));
  const catalog = createExtensionCatalog({ generation: 1, inputs: bytesDigest("inputs"), entries });
  const activation: NativeActivation = {
    version: 1,
    actor: bytesDigest("actor"),
    scopeKey: bytesDigest("scope"),
    scopeBinding: bytesDigest("binding"),
    authority: { scope: "user", id: bytesDigest("scope"), generation: 1 },
    package: prepared.package.identityDigest,
    installedRevision: 1,
    configuration: bytesDigest("config"),
    contributions: prepared.package.contributions.map((entry) => entry.identityDigest),
    revision: 1,
  };
  const owner = createNativeToolOwner({
    qualified: () => true,
    execute: async () => {
      throw new Error("registration must never execute");
    },
  });
  return {
    owner,
    input: {
      catalog,
      generation: configurationGeneration.from(1),
      packages: new Map([[prepared.package.identityDigest, prepared.package]]),
      activations: new Map(entries.map((entry) => [catalogEntryKey(entry), activation])),
      trust: { inspect: () => null },
      signal: new AbortController().signal,
    },
  };
}

test("native publication keeps kind ownership, closed schemas, disabled aliases and exact identities", async () => {
  const { owner, input } = await fixture();
  const publisher = createNativeRegistrationPublisher([owner]);
  const published = publisher.publish(input);
  expect(published.tools.registry.entries).toHaveLength(1);
  const tool = published.tools.registry.entries[0];
  if (!tool) throw new Error("missing tool");
  expect(tool.manifest.name.length).toBeLessThanOrEqual(64);
  expect(isClosedProductToolSchema(z.toJSONSchema(tool.manifest.inputSchema))).toBe(true);
  expect(published.tools.families?.get(tool.manifest.capabilityId)).toBe("read");
  expect(
    published.catalog.entries.find((entry) => entry.contribution.nativeKind === "skill")?.reason,
  ).toBe("native-owner-unavailable");
  expect(JSON.stringify(published.catalog)).not.toContain("PRIVATE-BODY");
  expect(
    resolveExtensionCatalog(published.catalog, {
      catalog: published.catalog.identity,
      target: { kind: "alias", name: "disabled" },
    }),
  ).toMatchObject({ status: "missing", reason: "alias-missing" });
  const withoutGrant = publisher.publish({ ...input, activations: new Map() });
  expect(withoutGrant.tools.registry.entries).toHaveLength(0);
  expect(
    withoutGrant.catalog.entries.some((entry) => entry.reason === "native-activation-required"),
  ).toBe(true);
  expect(published.tools.registry.entries).toHaveLength(1);
});

test("a malformed owner candidate cannot replace the last complete publication", async () => {
  const { owner, input } = await fixture();
  let corrupt = false;
  const adapter: NativeRegistrationOwner = {
    ...owner,
    register(context) {
      const value = owner.register(context);
      return corrupt && value.status === "registered"
        ? { ...value, binding: { ...value.binding, actionId: "forged" } }
        : value;
    },
  };
  const publisher = createNativeRegistrationPublisher([adapter]);
  const prior = publisher.publish(input);
  corrupt = true;
  expect(() => publisher.publish(input)).toThrow("native-owner-binding-mismatch");
  expect(publisher.current()).toBe(prior);
  expect(() => createNativeRegistrationPublisher([adapter, adapter])).toThrow(
    "duplicate-native-owner",
  );
  expect(() =>
    createNativeRegistrationPublisher([owner]).publish({ ...input, catalog: prior.catalog }),
  ).toThrow("native-input-already-bound");
  expect(() => publisher.publish({ ...input, signal: AbortSignal.abort() })).toThrow("cancelled");
  expect(publisher.current()).toBe(prior);
});

test("native dependencies cannot bind a disabled sibling through another scope", async () => {
  const { owner, input } = await fixture(true);
  const entries = input.catalog.entries.flatMap((entry): CatalogEntry[] => {
    if (entry.source.kind !== "package") throw new Error("package fixture");
    return [
      entry,
      {
        ...entry,
        enabled: true,
        source: {
          ...entry.source,
          activation: {
            ...entry.source.activation,
            scope: "workspace",
            scopeAuthorityId: bytesDigest("workspace"),
          },
        },
      },
    ];
  });
  const original = [...input.activations.values()][0];
  if (!original) throw new Error("activation fixture");
  const published = createNativeRegistrationPublisher([owner]).publish({
    ...input,
    catalog: createExtensionCatalog({ generation: 1, inputs: input.catalog.inputs, entries }),
    activations: new Map(
      entries.map((entry) => {
        if (entry.source.kind !== "package") throw new Error("package fixture");
        const scope = entry.source.activation;
        return [
          catalogEntryKey(entry),
          {
            ...original,
            scopeKey: scope.scopeAuthorityId,
            authority: {
              scope: scope.scope,
              id: scope.scopeAuthorityId,
              generation: scope.scopeAuthorityGeneration,
            },
          },
        ];
      }),
    ),
  });
  const good = published.catalog.entries.filter((entry) => entry.contribution.localId === "good");
  expect(
    good.find(
      (entry) => entry.source.kind === "package" && entry.source.activation.scope === "user",
    ),
  ).toMatchObject({
    availability: "unavailable",
    reason: "native-dependency-unavailable",
    binding: null,
  });
  expect(
    good.find(
      (entry) => entry.source.kind === "package" && entry.source.activation.scope === "workspace",
    ),
  ).toMatchObject({ availability: "available" });
  expect(published.tools.registry.entries).toHaveLength(2);
});

test("missing runners and forged families cannot replace a complete publication", async () => {
  const { owner, input } = await fixture();
  let fault: "missing" | "unbound" | "family" | null = null;
  const adapter: NativeRegistrationOwner = {
    ...owner,
    register(context) {
      const value = owner.register(context);
      if (value.status !== "registered" || !fault) return value;
      if (fault === "missing") return { status: "registered", binding: value.binding };
      if (fault === "family") return { ...value, binding: { ...value.binding, family: "search" } };
      if (!value.tool) throw new Error("tool fixture");
      return {
        ...value,
        tool: { ...value.tool, runner: { ...value.tool.runner, hasBinding: () => false } },
      };
    },
  };
  const publisher = createNativeRegistrationPublisher([adapter]);
  const prior = publisher.publish(input);
  for (const kind of ["missing", "unbound", "family"] as const) {
    fault = kind;
    expect(() => publisher.publish(input)).toThrow();
    expect(publisher.current()).toBe(prior);
  }
});
