import { describe, expect, test } from "bun:test";

import {
  checkModelCatalogs,
  commandCodeCatalogSource,
  modelCatalogDigest,
} from "./model-catalogs.ts";

describe("built-in model catalog generation", () => {
  test("keeps committed resources synchronized with their verified sources", async () => {
    await expect(checkModelCatalogs()).resolves.toBeUndefined();
  });

  test("produces deterministic Command Code bytes and digest", () => {
    const first = commandCodeCatalogSource();
    const second = commandCodeCatalogSource();
    expect(first).toBe(second);
    expect(modelCatalogDigest(first)).toMatch(/^sha-256:[0-9a-f]{64}$/u);
  });
});
