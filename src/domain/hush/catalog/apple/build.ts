/** Hush command-catalog policy for apple.build. */

import type { HushCatalogEntry } from "../contracts.ts";

export const APPLE_BUILD_POLICY = {
  reducerId: "apple.build",
  family: "build",
  projection: "build",
  executables: ["swift", "xcodebuild"],
  examples: ["swift build", "xcodebuild build"],
} as const satisfies HushCatalogEntry;
