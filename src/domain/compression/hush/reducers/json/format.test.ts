import { describe, expect, test } from "bun:test";

import { formatJsonStructure } from "./format.ts";

describe("JSON structure format", () => {
  test("retains every key and distinct array shape without retaining values", () => {
    const manyFields = Object.fromEntries(
      Array.from({ length: 24 }, (_, index) => [
        `field-${index.toString().padStart(2, "0")}`,
        `private-value-${index}`,
      ]),
    );
    const document = {
      manyFields,
      nested: { one: { two: { three: { four: { five: { six: { marker: "deep-secret" } } } } } } },
      variants: [
        { id: 1, name: "first-secret" },
        { id: 2, enabled: true },
        { id: 3, name: "third-secret" },
      ],
    };

    const formatted = formatJsonStructure(JSON.stringify(document));

    expect(formatted).not.toBeNull();
    for (const key of Object.keys(manyFields)) {
      expect(formatted).toContain(`${key} string`);
    }
    expect(formatted).toContain("marker string");
    expect(formatted).toContain("name string");
    expect(formatted).toContain("enabled boolean");
    expect(formatted).toContain("id integer");
    expect(formatted).not.toContain("private-value");
    expect(formatted).not.toContain("deep-secret");
    expect(formatted).not.toContain("first-secret");
  });

  test("rejects non-JSON text instead of guessing a structure", () => {
    expect(formatJsonStructure("service = falryn")).toBeNull();
  });
});
