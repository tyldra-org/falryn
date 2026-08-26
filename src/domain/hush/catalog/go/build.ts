/** Hush command-catalog policy for go.build. */

import type { HushCatalogEntry } from "../contracts.ts";

export const GO_BUILD_POLICY = {
  reducerId: "go.build",
  family: "build",
  projection: "build",
  executables: ["go"],
  examples: ["go build ./..."],
} as const satisfies HushCatalogEntry;
