/** Hush command-catalog policy for go.test. */

import type { HushCatalogEntry } from "../contracts.ts";

export const GO_TEST_POLICY = {
  reducerId: "go.test",
  family: "test",
  projection: "test",
  executables: ["go"],
  examples: ["go test ./..."],
  matches: (tokens) => tokens[1] === "test",
} as const satisfies HushCatalogEntry;
