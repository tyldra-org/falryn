/** Hush command-catalog policy for task.build. */

import type { HushCatalogEntry } from "../contracts.ts";

export const TASK_BUILD_POLICY = {
  reducerId: "task.build",
  family: "build",
  projection: "build",
  executables: ["just", "mise", "task", "make"],
  examples: ["just build", "mise run test", "task build", "make build"],
} as const satisfies HushCatalogEntry;
