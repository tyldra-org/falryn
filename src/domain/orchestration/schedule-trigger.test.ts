import { describe, expect, test } from "bun:test";
import { parseCalendar, scheduleTimingSchema, scheduleWindow } from "./schedule-trigger.ts";

const instant = (value: string) => Date.parse(value);
const identity = { id: "schedule", generation: 1, anchor: instant("2026-01-01T00:00:00Z") };
function window(raw: unknown, from: string, until: string) {
  return scheduleWindow(scheduleTimingSchema.parse(raw), identity, instant(from), instant(until));
}
describe("schedule eligibility", () => {
  test("closed triggers, RFC3339 offset, interval and jitter bounds", () => {
    for (const trigger of [
      { kind: "once", at: "2026-01-01T00:00:00" },
      { kind: "interval", everyMs: 999 },
      { kind: "interval", everyMs: 31_536_000_001 },
      { kind: "interval", everyMs: 1000, code: "run" },
      { kind: "calendar", expression: "* * * * *", timezone: "+02:00" },
    ])
      expect(scheduleTimingSchema.safeParse({ trigger }).success).toBe(false);
    for (const everyMs of [1000, 31_536_000_000])
      expect(
        scheduleTimingSchema.safeParse({ trigger: { kind: "interval", everyMs } }).success,
      ).toBe(true);
    for (const expression of [
      "* * * * * *",
      "@daily",
      "0 0 L * *",
      "0 0 * JAN *",
      "0 24 * * *",
      "0 0 * * 7",
      "*/0 * * * *",
      "0 0 4-2 * *",
    ])
      expect(parseCalendar(expression)).toBeNull();
  });
  test("once boundaries, interval cursor and stable delay-only jitter", () => {
    expect(
      window(
        { trigger: { kind: "once", at: "2026-01-02T02:00:00+02:00" }, end: "2026-01-02T00:00:00Z" },
        "2026-01-01T00:00:00Z",
        "2026-01-03T00:00:00Z",
      ).slots,
    ).toEqual([]);
    const timing = scheduleTimingSchema.parse({
      trigger: { kind: "interval", everyMs: 1000 },
      jitterMs: 900000,
    });
    const first = scheduleWindow(
      timing,
      identity,
      identity.anchor - 1,
      identity.anchor + 100000,
      3,
    );
    expect(first.slots).toHaveLength(3);
    expect(first.through).toBe(identity.anchor + 2000);
    expect(
      scheduleWindow(timing, identity, identity.anchor - 1, identity.anchor + 100000, 3),
    ).toEqual(first);
    for (const slot of first.slots) expect(slot.eligible - slot.nominal).toBeWithin(0, 1000);
  });
  test("restricted day fields use OR", () => {
    const result = window(
      { trigger: { kind: "calendar", expression: "0 0 15 * 1" } },
      "2026-06-01T00:00:00Z",
      "2026-06-17T00:00:00Z",
    );
    expect(result.slots.map((slot) => new Date(slot.nominal).toISOString())).toEqual([
      "2026-06-08T00:00:00.000Z",
      "2026-06-15T00:00:00.000Z",
    ]);
  });
  test("New York gap has evidence but no shifted execution; fold chooses earlier offset", () => {
    const gap = window(
      { trigger: { kind: "calendar", expression: "30 2 * * *", timezone: "America/New_York" } },
      "2026-03-08T00:00:00Z",
      "2026-03-09T00:00:00Z",
    );
    expect(gap.slots).toEqual([]);
    expect(gap.gaps).toEqual([{ start: "2026-03-08T02:30", end: "2026-03-08T02:30", count: 1 }]);
    const minutes = window(
      { trigger: { kind: "calendar", expression: "* 2 * * *", timezone: "America/New_York" } },
      "2026-03-08T00:00:00Z",
      "2026-03-09T00:00:00Z",
    );
    expect(minutes.gaps).toEqual([
      { start: "2026-03-08T02:00", end: "2026-03-08T02:59", count: 60 },
    ]);
    const fold = window(
      { trigger: { kind: "calendar", expression: "30 1 * * *", timezone: "America/New_York" } },
      "2026-11-01T00:00:00Z",
      "2026-11-02T00:00:00Z",
    );
    expect(fold.slots.map((slot) => new Date(slot.nominal).toISOString())).toEqual([
      "2026-11-01T05:30:00.000Z",
    ]);
    expect(
      window(
        { trigger: { kind: "calendar", expression: "30 1 * * *", timezone: "America/New_York" } },
        "2026-11-01T05:31:00Z",
        "2026-11-01T07:00:00Z",
      ).slots,
    ).toEqual([]);
  });
});
