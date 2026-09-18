/** Calendar eligibility is data. It never starts a task or acquires execution authority. */
import { z } from "zod";
import { canonicalDigest } from "../extensions/canonical.ts";

export const scheduleInstantSchema = z.iso
  .datetime({ offset: true })
  .refine((value) => Number.isFinite(Date.parse(value)));
export const scheduleTriggerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("once"), at: scheduleInstantSchema }),
  z.strictObject({
    kind: z.literal("interval"),
    everyMs: z.int().min(1000).max(31_536_000_000),
    startsAt: scheduleInstantSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("calendar"),
    expression: z
      .string()
      .min(9)
      .max(256)
      .refine((value) => parseCalendar(value) !== null),
    timezone: z.string().min(1).max(128).default("UTC").refine(validTimezone),
  }),
]);
export type ScheduleTrigger = z.infer<typeof scheduleTriggerSchema>;
export const scheduleTimingSchema = z
  .strictObject({
    trigger: scheduleTriggerSchema,
    start: scheduleInstantSchema.optional(),
    end: scheduleInstantSchema.optional(),
    jitterMs: z.int().min(0).max(900_000).default(0),
  })
  .refine((value) => !value.start || !value.end || Date.parse(value.start) < Date.parse(value.end));
export type ScheduleTiming = z.infer<typeof scheduleTimingSchema>;
type Calendar = { fields: readonly (readonly number[])[]; anyDay: boolean; anyWeekday: boolean };

export function parseCalendar(expression: string): Calendar | null {
  const parts = expression.trim().split(/\s+/u);
  const bounds = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ] as const;
  if (parts.length !== bounds.length) return null;
  const fields: number[][] = [];
  for (const [index, [min, max]] of bounds.entries()) {
    const values = new Set<number>();
    for (const part of (parts[index] ?? "").split(",")) {
      const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/u.exec(part);
      if (!match) return null;
      const range = match[1] ?? "";
      const step = match[2] === undefined ? 1 : Number(match[2]);
      const endpoints = range.split("-").map(Number);
      const from = range === "*" ? min : (endpoints[0] ?? -1);
      const to = range === "*" ? max : (endpoints[1] ?? (match[2] ? max : from));
      if (
        !Number.isInteger(step) ||
        step < 1 ||
        step > max - min + 1 ||
        from < min ||
        to > max ||
        from > to
      )
        return null;
      for (let value = from; value <= to; value += step) values.add(value);
    }
    fields.push([...values].sort((a, b) => a - b));
  }
  return { fields, anyDay: fields[2]?.length === 31, anyWeekday: fields[4]?.length === 7 };
}

function validTimezone(timezone: string): boolean {
  try {
    // Fixed offsets are not IANA identifiers. UTC is explicitly supported.
    if (/^[+-]/u.test(timezone)) return false;
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
    return true;
  } catch {
    return false;
  }
}

function formatter(timezone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    calendar: "gregory",
    numberingSystem: "latn",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
function wallTime(format: Intl.DateTimeFormat, instant: number): number {
  const parts = Object.fromEntries(
    format.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  const date = new Date(0);
  date.setUTCFullYear(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  date.setUTCHours(Number(parts.hour), Number(parts.minute), Number(parts.second), 0);
  return date.getTime();
}

/** Resolve both offsets around a transition, selecting the earlier fold. A gap has no instant. */
function resolveWall(format: Intl.DateTimeFormat, wall: number): number | null {
  const offsets = new Set(
    [-172_800_000, -86_400_000, 0, 86_400_000, 172_800_000].map((delta) => {
      const probe = wall + delta;
      return wallTime(format, probe) - probe;
    }),
  );
  const candidates = [...offsets]
    .map((offset) => wall - offset)
    .filter((at) => wallTime(format, at) === wall);
  return candidates.length ? Math.min(...candidates) : null;
}

export type ScheduleSlot = { nominal: number; eligible: number };
export type ScheduleWindow = {
  slots: readonly ScheduleSlot[];
  /** Resume from this exclusive instant. Bounded scans need not find a match. */
  through: number;
  gaps: readonly { start: string; end: string; count: number }[];
};

/** Bounded by days and output, independent of retained catalog/history size. */
export function scheduleWindow(
  timing: ScheduleTiming,
  identity: { id: string; generation: number; anchor: number },
  after: number,
  until: number,
  limit = 32,
): ScheduleWindow {
  const from = Math.max(after, (timing.start ? Date.parse(timing.start) : identity.anchor) - 1);
  const end = Math.min(until, timing.end ? Date.parse(timing.end) - 1 : until);
  if (end <= from) return { slots: [], through: end, gaps: [] };
  const nominal: number[] = [];
  const gaps: { start: string; end: string; count: number }[] = [];
  const trigger = timing.trigger;
  let through = end;
  if (trigger.kind === "once") {
    const at = Date.parse(trigger.at);
    if (at > from && at <= end) nominal.push(at);
  } else if (trigger.kind === "interval") {
    const anchor = trigger.startsAt ? Date.parse(trigger.startsAt) : identity.anchor;
    let at =
      anchor + Math.max(0, Math.floor((from - anchor) / trigger.everyMs) + 1) * trigger.everyMs;
    for (; at <= end && nominal.length < limit; at += trigger.everyMs) nominal.push(at);
    if (at <= end) through = nominal.at(-1) ?? from;
  } else {
    const parsed = parseCalendar(trigger.expression);
    if (!parsed) return { slots: [], through: from, gaps: [] };
    const format = formatter(trigger.timezone);
    const wallFrom = wallTime(format, from);
    const wallEnd = wallTime(format, end);
    const firstDay = new Date(wallFrom);
    firstDay.setUTCHours(0, 0, 0, 0);
    const [minutes = [], hours = [], days = [], months = [], weekdays = []] = parsed.fields;
    // UTC bounds include all supported zone offsets. Cap one query at 32 local days.
    const lastDay = Math.min(end + 86_400_000, firstDay.getTime() + 32 * 86_400_000);
    outer: for (let day = firstDay.getTime(); day <= lastDay; day += 86_400_000) {
      const date = new Date(day);
      const dom = days.includes(date.getUTCDate());
      const dow = weekdays.includes(date.getUTCDay());
      if (
        !months.includes(date.getUTCMonth() + 1) ||
        !(parsed.anyDay ? dow : parsed.anyWeekday ? dom : dom || dow)
      )
        continue;
      for (const hour of hours)
        for (const minute of minutes) {
          const wall = day + hour * 3_600_000 + minute * 60_000;
          if (wall <= wallFrom || wall > wallEnd + 86_400_000) continue;
          const at = resolveWall(format, wall);
          if (at === null) {
            // Gap evidence is local civil time, never a shifted executable slot.
            if (wall <= wallEnd) {
              const civil = new Date(wall).toISOString().slice(0, 16);
              const prior = gaps.at(-1);
              // A gap has no UTC cursor. Retain its matching civil minutes as one
              // range so a minute-by-minute spring gap cannot be truncated.
              if (prior?.start.slice(0, 10) === civil.slice(0, 10)) {
                prior.end = civil;
                prior.count++;
              } else gaps.push({ start: civil, end: civil, count: 1 });
            }
            continue;
          }
          if (at <= from || at > end) continue;
          if (nominal.length === limit) {
            through = nominal.at(-1) ?? from;
            break outer;
          }
          nominal.push(at);
        }
    }
    if (lastDay < end) through = Math.min(through, lastDay - 86_400_000);
  }
  const slots = nominal.map((at, index) => {
    const hash = canonicalDigest({ id: identity.id, generation: identity.generation, nominal: at });
    const delay = timing.jitterMs ? Number.parseInt(hash.slice(-8), 16) % (timing.jitterMs + 1) : 0;
    const spacing = trigger.kind === "interval" ? trigger.everyMs : Infinity;
    const next =
      nominal[index + 1] ??
      (trigger.kind === "calendar" && delay > 0
        ? (scheduleWindow({ ...timing, jitterMs: 0 }, identity, at, at + delay, 1).slots[0]
            ?.nominal ?? Infinity)
        : at + spacing);
    return { nominal: at, eligible: at + Math.min(delay, next - at - 1) };
  });
  return { slots, through, gaps };
}
