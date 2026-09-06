/**
 * Stable data-export facade.
 *
 * Inventory selection is fully resolved and bounded before the independent
 * package writer is allowed to stage or stream bytes.
 */

export { resolveInventory } from "./export/inventory.ts";
export {
  EXPORT_CHUNK_BYTES,
  verifyPackage,
  WRITTEN_SCHEMA_FAMILIES,
  writePackage,
} from "./export/package.ts";
export type { ExportOptions } from "./export/shared.ts";
