import { expect, test } from "bun:test";
import type { SensitiveValueRedactor } from "../configuration/index.ts";
import { bytesDigest } from "../extensions/canonical.ts";
import { catalogFixture } from "../extensions/catalog-fixtures.ts";
import { type ExportRedaction, redactExportValue } from "./export.ts";

const redactor: SensitiveValueRedactor = {
  placeholder: "[redacted]",
  isSecretName: (key) => /auth|secret|password/i.test(key),
  redactText: (text) => text.replace(/credential-value/g, "[redacted]"),
};

function activation() {
  const source = catalogFixture("scope-export").source;
  if (source.kind !== "package") throw new Error("expected package fixture");
  return source.activation;
}

test("export preserves validated scope digests and numeric generations, not authentication", () => {
  const value = activation();
  const redactions: ExportRedaction[] = [];
  expect(redactExportValue(value, redactor, redactions)).toEqual({ ok: true, value });
  expect(redactions).toEqual([]);
});

test("scope-looking keys cannot exempt arbitrary or malformed credential metadata", () => {
  for (const value of [
    { scopeAuthorityId: "credential-value", scopeAuthorityGeneration: "credential-value" },
    { ...activation(), scopeAuthorityGeneration: "credential-value" },
    { ...activation(), extra: { password: "credential-value" } },
  ]) {
    const result = redactExportValue(value, redactor, []);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("credential-value");
  }
  const value = { ...activation(), scopeAuthorityId: "credential-value" };
  expect(redactExportValue(value, redactor, [])).toEqual({
    ok: true,
    value: { ...value, scopeAuthorityId: "[redacted]" },
  });
});

test("scope exception does not preserve other auth values or mutate the source", () => {
  const value = {
    activation: activation(),
    authToken: "credential-value",
    metadata: { scopeAuthorityId: bytesDigest("not a validated scope identity") },
  };
  const redactions: ExportRedaction[] = [];
  expect(redactExportValue(value, redactor, redactions)).toEqual({
    ok: true,
    value: {
      activation: value.activation,
      authToken: "[redacted]",
      metadata: { scopeAuthorityId: "[redacted]" },
    },
  });
  expect(value.authToken).toBe("credential-value");
  expect(redactions).toHaveLength(2);
});

test("numeric model token budgets remain decodable while credential-shaped values stay redacted", () => {
  const tokenRedactor = { ...redactor, isSecretName: (key: string) => /token|auth/i.test(key) };
  const counts = {
    schemaTokensEstimated: 100,
    schemaTokenBudget: 4096,
    inputTokens: null,
    outputTokens: 8192,
  };
  expect(redactExportValue(counts, tokenRedactor, [])).toEqual({ ok: true, value: counts });
  for (const value of ["credential-value", {}, -1, 0.5]) {
    expect(redactExportValue({ inputTokens: value, authToken: 123456 }, tokenRedactor, [])).toEqual(
      {
        ok: true,
        value: { inputTokens: "[redacted]", authToken: "[redacted]" },
      },
    );
  }
});
