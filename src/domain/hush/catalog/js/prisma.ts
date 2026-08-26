/** Hush command-catalog policy for js.prisma. */

import type { HushCatalogEntry } from "../contracts.ts";

export const JS_PRISMA_POLICY = {
  reducerId: "js.prisma",
  family: "build",
  projection: "operation",
  executables: ["prisma"],
  examples: [
    "prisma generate",
    "prisma migrate dev",
    "prisma migrate status",
    "prisma migrate deploy",
    "prisma db push",
    "prisma validate",
  ],
} as const satisfies HushCatalogEntry;
