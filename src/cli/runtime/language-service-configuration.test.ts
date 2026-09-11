import { expect, test } from "bun:test";
import { languageServicesSchema } from "../../application/tools/product-language-tools/configuration.ts";
import { languageServiceFixtureConfiguration } from "../../application/tools/product-language-tools/test-support.ts";
import { MARKING_REDACTOR } from "../../config/fixtures.ts";
import { createConfigurationRegistry } from "../../config/index.ts";
import {
  LANGUAGE_SERVICE_CONFIGURATION_KEYS,
  languageServiceConfiguration,
} from "./language-service-configuration.ts";

test("only the user configuration can authorize language executables and targets", () => {
  const registry = createConfigurationRegistry({
    declarations: LANGUAGE_SERVICE_CONFIGURATION_KEYS,
    redactor: MARKING_REDACTOR,
  });
  const document = {
    schemaVersion: 1,
    tools: { languageServices: languageServiceFixtureConfiguration("/work") },
  };
  expect(registry.validateLayer(document, { scope: "user", sourceKind: "user-file" }).ok).toBe(
    true,
  );
  for (const context of [
    { scope: "project", sourceKind: "project-file" },
    { scope: "profile", sourceKind: "profile" },
    { scope: "environment", sourceKind: "environment" },
    { scope: "cli", sourceKind: "cli-override" },
  ] as const) {
    expect(registry.validateLayer(document, context).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "scope-unavailable" })]),
    );
  }
  expect(LANGUAGE_SERVICE_CONFIGURATION_KEYS[0]?.descriptor.sensitivity).toBe("sensitive");
  expect(() => languageServiceConfiguration({}, 0, null)).toThrow(
    "language-service-configuration-unavailable",
  );
});

test("configured extension values retain protocol bounds and reject duplicate service identities", () => {
  const configuration = languageServiceFixtureConfiguration("/work");
  const server = configuration.languageServers[0];
  if (!server) throw new Error("fixture server missing");
  configuration.languageServers.push(server);
  expect(languageServicesSchema.safeParse(configuration).success).toBe(false);
  configuration.languageServers.pop();
  let nested: unknown = "value";
  for (let i = 0; i < 10; i++) nested = { child: nested };
  server.initialize.capabilities = { nested };
  expect(languageServicesSchema.safeParse(configuration).success).toBe(false);
});
