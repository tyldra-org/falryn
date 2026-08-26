/** Hush command-catalog policy for js.package. */

import type { HushCatalogEntry } from "../contracts.ts";

export const JS_PACKAGE_POLICY = {
  reducerId: "js.package",
  family: "package",
  projection: "package",
  executables: ["npm", "pnpm", "yarn", "npx", "pnpx"],
  examples: [
    "npm run custom",
    "npm exec custom",
    "pnpm install",
    "pnpm list",
    "pnpm outdated",
    "pnpm run custom",
    "npx custom-tool",
  ],
} as const satisfies HushCatalogEntry;
