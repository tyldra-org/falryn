/** Hush command-catalog policy for bun.build. */

import type { HushCatalogEntry } from "../contracts.ts";

export const BUN_BUILD_POLICY = {
  reducerId: "bun.build",
  family: "build",
  projection: "build",
  executables: ["bun"],
  examples: ["bun run build"],
  matches: (tokens) => tokens[1] === "run" && tokens[2] === "build",
} as const satisfies HushCatalogEntry;
