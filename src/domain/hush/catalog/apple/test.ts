/** Hush command-catalog policy for apple.test. */

import type { HushCatalogEntry } from "../contracts.ts";

export const APPLE_TEST_POLICY = {
  reducerId: "apple.test",
  family: "test",
  projection: "test",
  executables: ["swift", "xcodebuild"],
  examples: ["swift test", "xcodebuild test"],
  matches: (tokens) => tokens.includes("test"),
} as const satisfies HushCatalogEntry;
