/** Hush command-catalog policy for js.typecheck. */

import type { HushCatalogEntry } from "../contracts.ts";

export const JS_TYPECHECK_POLICY = {
  reducerId: "js.typecheck",
  family: "typecheck",
  projection: "diagnostic",
  executables: ["tsc", "basedpyright", "ty"],
  examples: ["tsc --noEmit", "basedpyright", "ty check"],
} as const satisfies HushCatalogEntry;
