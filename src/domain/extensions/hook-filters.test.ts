import { expect, test } from "bun:test";
import { matchesHookFilters } from "./hook-filters.ts";
import { hookFixtureEnvelope } from "./hook-fixtures.ts";
import { hookRegistrationSchema } from "./hook-handlers.ts";
import { HOOK_POINTS } from "./hook-points.ts";

test("exact and prefix filters compose; absent fields do not match", () => {
  const envelope = hookFixtureEnvelope();
  const registration = (filters: unknown) =>
    hookRegistrationSchema.parse({
      version: 1,
      point: envelope.point,
      pointVersion: 1,
      mode: "sync",
      handler: { kind: "builtin", id: "filter" },
      filters,
    });
  expect(
    matchesHookFilters(
      registration([
        { field: "capabilityId", operator: "prefix", value: "builtin:" },
        { field: "declaredEffect", operator: "exact", value: "observation" },
      ]),
      envelope,
    ),
  ).toBe(true);
  expect(
    matchesHookFilters(
      registration([{ field: "capabilityId", operator: "exact", value: "builtin:" }]),
      envelope,
    ),
  ).toBe(false);
  expect(() =>
    registration(
      Array.from({ length: 33 }, () => ({ field: "capabilityId", operator: "exact", value: "x" })),
    ),
  ).toThrow();
  expect(() =>
    registration([{ field: "capabilityId", operator: "exact", value: "x".repeat(257) }]),
  ).toThrow();
});
test("relative glob matches one path segment without regex or path traversal", () => {
  const point = Object.entries(HOOK_POINTS).find(([, descriptor]) =>
    descriptor.filters.includes("paths"),
  )?.[0];
  expect(point).toBeDefined();
  const registration = hookRegistrationSchema.parse({
    version: 1,
    point,
    pointVersion: 1,
    mode: "sync",
    handler: { kind: "builtin", id: "filter" },
    filters: [{ field: "paths", operator: "glob", value: "src/*.t?" }],
  });
  // The matcher consumes already validated owner envelopes, not arbitrary callback payloads.
  const subject = { ...hookFixtureEnvelope(), payload: { paths: ["src/main.ts"] } };
  expect(
    matchesHookFilters(registration, subject as unknown as ReturnType<typeof hookFixtureEnvelope>),
  ).toBe(true);
  expect(
    matchesHookFilters(registration, {
      ...subject,
      payload: { paths: ["src/deep/main.ts"] },
    } as unknown as ReturnType<typeof hookFixtureEnvelope>),
  ).toBe(false);
  expect(() =>
    hookRegistrationSchema.parse({
      ...registration,
      filters: [{ field: "paths", operator: "glob", value: "../*.ts" }],
    }),
  ).toThrow();
});
