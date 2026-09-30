import { expect, test } from "bun:test";
import {
  catalogFreshness,
  marketplaceConfigurationSchema,
  marketplaceCredentialReference,
  marketplaceSourceSchema,
} from "./marketplace.ts";

const URL = "https://market.example.test/catalog.json";
const source = (value: Record<string, unknown> = {}) =>
  marketplaceSourceSchema.parse({ id: "market", url: URL, ...value });

test("a marketplace location is plain https with no credentials, query or fragment", () => {
  expect(source()).toEqual({ id: "market", url: URL, enabled: true, maxAgeHours: 24 });
  for (const url of [
    "http://market.example.test/catalog.json",
    "https://user:secret@market.example.test/catalog.json",
    `${URL}?token=secret`,
    `${URL}#top`,
    "https://market.example.test/ catalog.json",
    "file:///etc/passwd",
  ])
    expect(marketplaceSourceSchema.safeParse({ id: "market", url }).success).toBe(false);
  expect(marketplaceSourceSchema.safeParse({ id: "Market", url: URL }).success).toBe(false);
  expect(
    marketplaceSourceSchema.safeParse({
      id: "market",
      url: URL,
      credential: { storeKind: "environment", locator: "TOKEN" },
      credentialEnvironment: "TOKEN",
    }).success,
  ).toBe(false);
  expect(marketplaceConfigurationSchema.safeParse({ sources: [source(), source()] }).success).toBe(
    false,
  );
  expect(
    marketplaceConfigurationSchema.safeParse({
      sources: Array.from({ length: 17 }, (_, index) => source({ id: `m${index}` })),
    }).success,
  ).toBe(false);
});

test("a marketplace credential is bound to that marketplace as its only consumer", () => {
  expect(marketplaceCredentialReference(source())).toBeNull();
  expect(marketplaceCredentialReference(source({ credentialEnvironment: "MARKET_TOKEN" }))).toEqual(
    {
      storeKind: "environment",
      locator: "MARKET_TOKEN",
      consumer: "marketplace:market",
      accountLabel: null,
    },
  );
});

test("freshness is a dated fact about the configured location, never assumed", () => {
  const origin = {
    kind: "marketplace" as const,
    url: URL,
    fetchedAt: 1_000,
    bodyDigest: `sha256:${"b".repeat(64)}`,
  };
  const hour = 3_600_000;
  expect(catalogFreshness({ kind: "file" }, "market", [], 0)).toEqual({ state: "local" });
  expect(catalogFreshness(origin, "market", null, 0)).toEqual({
    state: "unknown",
    fetchedAt: 1_000,
  });
  expect(catalogFreshness(origin, "market", [source()], 1_000 + 24 * hour)).toEqual({
    state: "fresh",
    fetchedAt: 1_000,
    maxAgeHours: 24,
  });
  expect(catalogFreshness(origin, "market", [source()], 1_001 + 24 * hour)).toMatchObject({
    state: "stale",
  });
  expect(
    catalogFreshness(origin, "market", [source({ url: "https://other.example.test/c.json" })], 0),
  ).toEqual({ state: "unconfigured", fetchedAt: 1_000 });
  expect(catalogFreshness(origin, "market", [], 0)).toMatchObject({ state: "unconfigured" });
  expect(catalogFreshness(origin, "market", [source({ enabled: false })], 0)).toMatchObject({
    state: "disabled",
  });
});
