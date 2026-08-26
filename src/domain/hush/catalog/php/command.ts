/** Hush command-catalog policy for php.command. */

import type { HushCatalogEntry } from "../contracts.ts";

export const PHP_COMMAND_POLICY = {
  reducerId: "php.command",
  family: "build",
  projection: "operation",
  executables: ["php"],
  examples: ["php app.php", "php artisan about", "php -l app.php"],
} as const satisfies HushCatalogEntry;
