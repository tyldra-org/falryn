/** Hush command-catalog policy for dotnet.build. */

import type { HushCatalogEntry } from "../contracts.ts";

export const DOTNET_BUILD_POLICY = {
  reducerId: "dotnet.build",
  family: "build",
  projection: "build",
  executables: ["dotnet"],
  examples: ["dotnet build", "dotnet restore"],
} as const satisfies HushCatalogEntry;
