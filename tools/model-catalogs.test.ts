import { describe, expect, test } from "bun:test";

import {
  checkModelCatalogs,
  commandCodeCatalogSource,
  modelCatalogDigest,
} from "./model-catalogs.ts";

describe("built-in model catalog generation", () => {
  test("keeps committed resources synchronized with their verified sources", async () => {
    const reports = await checkModelCatalogs();
    expect(reports.map((report) => report.catalogId)).toEqual([
      "falryn.openai",
      "falryn.anthropic",
      "falryn.google",
      "falryn.commandcode",
    ]);
    expect(reports.map((report) => report.modelCount)).toEqual([10, 4, 5, 62]);
    expect(reports.filter((report) => report.generated).map((report) => report.catalogId)).toEqual([
      "falryn.commandcode",
    ]);
    expect(reports.every((report) => /^sha-256:[0-9a-f]{64}$/u.test(report.digest))).toBe(true);
  });

  test("produces deterministic Command Code bytes and digest", () => {
    const first = commandCodeCatalogSource();
    const second = commandCodeCatalogSource();
    expect(first).toBe(second);
    expect(modelCatalogDigest(first)).toMatch(/^sha-256:[0-9a-f]{64}$/u);
  });
});
