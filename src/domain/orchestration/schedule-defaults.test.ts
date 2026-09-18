import { expect, test } from "bun:test";
import {
  resolveScheduleDefaults,
  scheduleDefaultsSchema,
  scheduleDraftSchema,
} from "./schedule-defaults.ts";

test("profile defaults fill only omitted values and cannot enable or rewrite a definition", () => {
  const input = {
    version: 1,
    timing: { trigger: { kind: "calendar", expression: "0 9 * * 1" } },
    target: { kind: "action", capability: "builtin:workspace/stat_path@1", input: { path: "." } },
  } as const;
  const raw = scheduleDraftSchema.parse(input);
  expect(raw).toEqual(input);
  const defaults = scheduleDefaultsSchema.parse({
    version: 1,
    timezone: "America/New_York",
    jitterMs: 100,
    missed: { kind: "latest" },
  });
  const defined = resolveScheduleDefaults(raw, defaults);
  expect(defined).toMatchObject({
    timing: { trigger: { timezone: "America/New_York" }, jitterMs: 100 },
    missed: { kind: "latest" },
  });
  const explicit = resolveScheduleDefaults(
    { ...raw, timing: { ...raw.timing, jitterMs: 0 }, missed: { kind: "none" } },
    defaults,
  );
  expect(explicit).toMatchObject({ timing: { jitterMs: 0 }, missed: { kind: "none" } });
  expect(scheduleDefaultsSchema.safeParse({ ...defaults, enabled: true }).success).toBe(false);
  expect(resolveScheduleDefaults(defined, scheduleDefaultsSchema.parse({ version: 1 }))).toEqual(
    defined,
  );
});
