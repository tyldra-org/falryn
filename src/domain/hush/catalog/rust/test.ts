/** Hush command-catalog policy for rust.test. */

import type { HushCatalogEntry } from "../contracts.ts";

export const RUST_TEST_POLICY = {
  reducerId: "rust.test",
  family: "test",
  projection: "test",
  executables: ["cargo"],
  examples: ["cargo test", "cargo nextest run"],
  matches: (tokens) => tokens[1] === "test" || (tokens[1] === "nextest" && tokens[2] === "run"),
} as const satisfies HushCatalogEntry;
