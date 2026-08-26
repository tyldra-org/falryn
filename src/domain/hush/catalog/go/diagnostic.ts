/** Hush command-catalog policy for go.diagnostic. */

import type { HushCatalogEntry } from "../contracts.ts";

export const GO_DIAGNOSTIC_POLICY = {
  reducerId: "go.diagnostic",
  family: "lint",
  projection: "diagnostic",
  executables: ["go", "golangci-lint", "golangci"],
  examples: ["go vet ./...", "golangci-lint run", "golangci run"],
  matches: (tokens) => tokens[0] !== "go" || tokens[1] === "vet",
} as const satisfies HushCatalogEntry;
