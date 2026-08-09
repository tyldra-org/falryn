import { describe, expect, test } from "bun:test";

import {
  SCHEMA_FIXTURE_CASES,
  SCHEMA_FIXTURE_FAMILIES,
  SCHEMA_FIXTURES,
  type SchemaFixture,
} from "./schema-fixtures.ts";

function fixturesFor(family: SchemaFixture["family"]): readonly SchemaFixture[] {
  return SCHEMA_FIXTURES.filter((fixture) => fixture.family === family);
}

describe("the schema fixture matrix", () => {
  test("has one deterministic identity for every reader and required case", () => {
    expect(new Set(SCHEMA_FIXTURES.map((fixture) => fixture.id)).size).toBe(SCHEMA_FIXTURES.length);

    for (const family of SCHEMA_FIXTURE_FAMILIES) {
      expect(
        fixturesFor(family)
          .map((fixture) => fixture.scenario)
          .sort(),
      ).toEqual([...SCHEMA_FIXTURE_CASES].sort());
    }
  });

  test.each(SCHEMA_FIXTURES.map((fixture) => [fixture.id, fixture] as const))(
    "%s reaches the declared outcome through its real reader",
    (_id, fixture) => {
      const observed = fixture.observe();

      expect(observed.outcome).toBe(fixture.expected);
      if (fixture.withheldValue !== null) {
        expect(observed.rendered).not.toContain(fixture.withheldValue);
      }
    },
  );
});
