/** Hush command-catalog policy for rust.diagnostic. */

import type { HushCatalogEntry } from "../contracts.ts";

export const RUST_DIAGNOSTIC_POLICY = {
  reducerId: "rust.diagnostic",
  family: "lint",
  projection: "diagnostic",
  executables: ["cargo", "clippy"],
  examples: ["cargo clippy", "cargo check", "cargo fmt --check", "clippy"],
  matches: (tokens) => ["check", "clippy", "fmt"].includes(tokens[1] ?? "clippy"),
} as const satisfies HushCatalogEntry;
