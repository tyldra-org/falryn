/** Profile defaults are copied only when preparing a new definition. */
import { z } from "zod";
import { scheduleDefinitionSchema } from "./schedule-state.ts";
import { scheduleTimingSchema, scheduleTriggerSchema } from "./schedule-trigger.ts";

export const scheduleDefaultsSchema = z.strictObject({
  version: z.literal(1),
  overlap: scheduleDefinitionSchema.shape.overlap,
  missed: scheduleDefinitionSchema.shape.missed,
  lookbackMs: scheduleDefinitionSchema.shape.lookbackMs,
  jitterMs: scheduleTimingSchema.shape.jitterMs,
  timezone: scheduleTriggerSchema.options[2].shape.timezone,
});
export type ScheduleDefaults = z.infer<typeof scheduleDefaultsSchema>;
/** Validate without applying defaults before the application sees the selected profile. */
export const scheduleDraftSchema = z.custom<z.input<typeof scheduleDefinitionSchema>>((value) => {
  try {
    return scheduleDefinitionSchema.safeParse(value).success;
  } catch {
    return false;
  }
});
export function resolveScheduleDefaults(
  input: z.input<typeof scheduleDefinitionSchema>,
  defaults?: ScheduleDefaults,
) {
  return scheduleDefinitionSchema.parse({
    ...(defaults
      ? { overlap: defaults.overlap, missed: defaults.missed, lookbackMs: defaults.lookbackMs }
      : {}),
    ...input,
    timing: {
      ...(defaults ? { jitterMs: defaults.jitterMs } : {}),
      ...input.timing,
      trigger:
        input.timing.trigger.kind === "calendar"
          ? { ...(defaults ? { timezone: defaults.timezone } : {}), ...input.timing.trigger }
          : input.timing.trigger,
    },
  });
}
