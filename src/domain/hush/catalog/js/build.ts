/** Hush command-catalog policy for js.build. */

import type { HushCatalogEntry } from "../contracts.ts";

export const JS_BUILD_POLICY = {
  reducerId: "js.build",
  family: "build",
  projection: "build",
  executables: ["next", "nx", "turbo"],
  examples: ["next build", "nx build app", "turbo build"],
} as const satisfies HushCatalogEntry;
