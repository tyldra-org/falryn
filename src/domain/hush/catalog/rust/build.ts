/** Hush command-catalog policy for rust.build. */

import type { HushCatalogEntry } from "../contracts.ts";

export const RUST_BUILD_POLICY = {
  reducerId: "rust.build",
  family: "build",
  projection: "build",
  executables: ["cargo"],
  examples: ["cargo build", "cargo install ripgrep"],
} as const satisfies HushCatalogEntry;
