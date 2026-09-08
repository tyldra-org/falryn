import { describe, expect, test } from "bun:test";
import {
  bytesDigest,
  canonicalDigest,
  canonicalJson,
  packageRelativePath,
  parseMetadata,
} from "./canonical.ts";
import {
  builtinOwnerIdentityV1Schema,
  type CapabilityBindingV1,
  type ContributionIdentityV1,
  decodeIdentity,
  type ExtensionActivationIdentityV1,
  validateCapabilityBinding,
} from "./identity.ts";

const digest = bytesDigest("fixture");
describe("canonical extension identities", () => {
  test("normalizes metadata without changing exact file integrity", () => {
    expect(canonicalJson({ z: "e\u0301\r\nx", a: 1 })).toBe('{"a":1,"z":"é\\nx"}');
    expect(canonicalJson({ "2": "two", "10": "ten" })).toBe('{"10":"ten","2":"two"}');
    expect(canonicalDigest({ b: 2, a: 1 })).toBe(canonicalDigest({ a: 1, b: 2 }));
    expect(bytesDigest("é")).not.toBe(bytesDigest("e\u0301"));
  });
  test("rejects ambiguous and non-JSON inputs", () => {
    for (const value of ['{"x":1,"x":2}', '{"é":1,"e\\u0301":2}', '{/*x*/"a":1}', '{"x":1,}'])
      expect(() => parseMetadata(value)).toThrow();
    for (const value of [NaN, undefined, new Date(), "\ud800", { a: undefined }])
      expect(() => canonicalJson(value)).toThrow();
    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(() => canonicalJson(cycle)).toThrow();
    expect(() => canonicalJson({ é: 1, "e\u0301": 2 })).toThrow();
  });
  test("rejects paths that could select a different host resource", () => {
    for (const path of ["/etc/passwd", "../x", "a/../x", "C:\\x", "a//x", "a/./x", "x.", ""])
      expect(packageRelativePath(path)).toBeNull();
    expect(packageRelativePath("./scripts\\task.ts")).toBe("scripts/task.ts");
  });
  test("strict codecs preserve version and freeze identity", () => {
    const input = {
      version: 1,
      release: "0.0.0",
      buildDigest: digest,
      nativeOwnerId: "falryn",
      catalogGeneration: 1,
    };
    const decoded = decodeIdentity(builtinOwnerIdentityV1Schema, input);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(Object.isFrozen(decoded.value)).toBe(true);
    expect(decodeIdentity(builtinOwnerIdentityV1Schema, { ...input, health: "ready" }).ok).toBe(
      false,
    );
    expect(
      decodeIdentity(builtinOwnerIdentityV1Schema, { ...input, catalogGeneration: 2 }),
    ).not.toEqual(decoded);
  });
  test("active package bindings require matching activation and generation", () => {
    const contribution: ContributionIdentityV1 = {
      version: 1,
      owner: { kind: "package", digest },
      nativeKind: "agent",
      namespace: "test",
      localId: "worker",
      descriptorDigest: digest,
    };
    const activation: ExtensionActivationIdentityV1 = {
      version: 1,
      packageIdentityDigest: digest,
      scope: "session",
      scopeAuthorityId: "session-1",
      scopeAuthorityGeneration: 1,
      configurationGeneration: 1,
      activationRevision: 1,
      catalogGeneration: 2,
    };
    const binding: CapabilityBindingV1 = {
      version: 1,
      contributionIdentityDigest: canonicalDigest(contribution),
      extensionActivationDigest: canonicalDigest(activation),
      nativeRegistryOwner: "agents",
      nativeRegistryGeneration: 1,
      actionId: "worker",
      family: "delegate",
      schemaDigest: digest,
      effectDigest: digest,
      authorityDigest: digest,
      resultDigest: digest,
      settlementDigest: digest,
      catalogGeneration: 2,
    };
    expect(
      validateCapabilityBinding({ contribution, binding, activation, state: "executable" }),
    ).toBe(true);
    expect(validateCapabilityBinding({ contribution, binding, state: "executable" })).toBe(false);
    expect(
      validateCapabilityBinding({
        contribution,
        binding,
        activation: { ...activation, catalogGeneration: 3 },
        state: "executable",
      }),
    ).toBe(false);
    expect(
      validateCapabilityBinding({
        contribution: { ...contribution, owner: { kind: "builtin", digest } },
        binding,
        activation,
        state: "executable",
      }),
    ).toBe(false);
  });
});
