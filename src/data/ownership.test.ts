import { describe, expect, test } from "bun:test";

import { DIAGNOSTICS_OWNERSHIP } from "../application/index.ts";
import { CONFIGURATION_OWNERSHIP } from "../config/index.ts";
import { OWNERSHIP_CLASSES, type OwnershipRegistration } from "../domain/index.ts";
import {
  CREDENTIAL_REFERENCE_OWNERSHIP,
  createOwnershipRegistry,
  TEMPORARY_INGEST_OWNERSHIP,
} from "./ownership.ts";

const V0_1_REGISTRATIONS: readonly OwnershipRegistration[] = [
  CONFIGURATION_OWNERSHIP,
  CREDENTIAL_REFERENCE_OWNERSHIP,
  DIAGNOSTICS_OWNERSHIP,
  TEMPORARY_INGEST_OWNERSHIP,
];

describe("the ownership registry", () => {
  test("starts empty, because membership in the vocabulary is not registration", () => {
    const registry = createOwnershipRegistry();
    expect(registry.registrations()).toEqual([]);
    expect(registry.unregistered()).toEqual([...OWNERSHIP_CLASSES]);
  });

  test("accepts a registration and finds it by class", () => {
    const registry = createOwnershipRegistry();
    expect(registry.register(CONFIGURATION_OWNERSHIP).ok).toBe(true);
    expect(registry.find("configuration")).toEqual(CONFIGURATION_OWNERSHIP);
    expect(registry.unregistered()).not.toContain("configuration");
  });

  test("refuses a second owner for one class", () => {
    const registry = createOwnershipRegistry();
    registry.register(CONFIGURATION_OWNERSHIP);
    const second = registry.register({ ...CONFIGURATION_OWNERSHIP, owner: "someone-else" });

    expect(second.ok).toBe(false);
    if (!second.ok) {
      // Two owners means two answers to "may this be deleted".
      expect(second.error.code).toBe("class-already-registered");
    }
    expect(registry.find("configuration")?.owner).toBe("config");
  });

  test("refuses a class outside the documented vocabulary", () => {
    const registry = createOwnershipRegistry();
    const result = registry.register({
      ...CONFIGURATION_OWNERSHIP,
      ownershipClass: "invented" as OwnershipRegistration["ownershipClass"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("unknown-ownership-class");
    }
  });

  test("refuses an external class that also claims roots", () => {
    const registry = createOwnershipRegistry();
    const result = registry.register({ ...CREDENTIAL_REFERENCE_OWNERSHIP, roots: ["state"] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("external-class-declares-roots");
    }
  });

  test("refuses an owned class that claims nothing", () => {
    const registry = createOwnershipRegistry();
    const result = registry.register({ ...CONFIGURATION_OWNERSHIP, roots: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("owned-class-declares-no-root");
    }
  });

  test("reports every class no owner registered", () => {
    const registry = createOwnershipRegistry();
    for (const registration of V0_1_REGISTRATIONS) {
      registry.register(registration);
    }
    expect([...registry.unregistered()].sort()).toEqual([
      "artifacts",
      "cache",
      "exports",
      "extensions",
      "memory",
      "sqliteState",
    ]);
  });
});

describe("the v0.1 registrations", () => {
  test("each sits with the owner that claims it", () => {
    // The rule is that an owner registers its own class. Configuration is
    // declared by the configuration area and logs by the diagnostics collector,
    // so neither can drift from the code that actually writes those bytes.
    expect(CONFIGURATION_OWNERSHIP.owner).toBe("config");
    expect(DIAGNOSTICS_OWNERSHIP.owner).toBe("diagnostics");
    expect(TEMPORARY_INGEST_OWNERSHIP.owner).toBe("local-data");
    expect(CREDENTIAL_REFERENCE_OWNERSHIP.owner).toBe("credentials");
  });

  test("all four register together without conflicting", () => {
    const registry = createOwnershipRegistry();
    for (const registration of V0_1_REGISTRATIONS) {
      expect(registry.register(registration).ok).toBe(true);
    }
    expect(registry.registrations()).toHaveLength(4);
  });

  test("credentials own no bytes inside these roots", () => {
    expect(CREDENTIAL_REFERENCE_OWNERSHIP.external).toBe(true);
    expect(CREDENTIAL_REFERENCE_OWNERSHIP.roots).toEqual([]);
    // Local reference removal, secret deletion, and remote revocation are three
    // separate actions, so the class carries its own posture.
    expect(CREDENTIAL_REFERENCE_OWNERSHIP.removalPosture).toBe("separate-action");
  });

  test("user-authored configuration is preserved unless it is selected", () => {
    expect(CONFIGURATION_OWNERSHIP.durability).toBe("user-authored");
    expect(CONFIGURATION_OWNERSHIP.removalPosture).toBe("preserve-unless-selected");
  });
});
