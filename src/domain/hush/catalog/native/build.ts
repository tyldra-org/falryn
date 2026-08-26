/** Hush command-catalog policy for native.build. */

import type { HushCatalogEntry } from "../contracts.ts";

export const NATIVE_BUILD_POLICY = {
  reducerId: "native.build",
  family: "build",
  projection: "build",
  executables: ["gcc", "g++", "pio", "quarto", "trunk"],
  examples: ["gcc main.c", "g++ main.cpp", "pio run", "quarto render", "trunk build"],
} as const satisfies HushCatalogEntry;
