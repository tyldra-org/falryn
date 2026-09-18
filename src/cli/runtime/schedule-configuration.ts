import { type ConfigurationKeyDeclaration, objectKey } from "../../config/index.ts";
import { scheduleDefaultsSchema } from "../../domain/orchestration/schedule-defaults.ts";
export const SCHEDULE_CONFIGURATION_KEY = "execution.schedules";
export const SCHEDULE_CONFIGURATION_KEYS: readonly ConfigurationKeyDeclaration[] = [
  objectKey({
    path: SCHEDULE_CONFIGURATION_KEY,
    summary:
      "Defaults copied into new schedules. Configuration selection never registers, enables or changes existing schedules.",
    objectSchema: scheduleDefaultsSchema,
    defaultValue: scheduleDefaultsSchema.parse({ version: 1 }),
    scopes: ["user", "profile"],
    applicationClass: "next-operation",
    sensitivity: "public",
  }),
];
