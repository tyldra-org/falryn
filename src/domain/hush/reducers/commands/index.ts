/** Complete reducer registry for every catalog-owned Hush command. */

import type { HushCatalogReducerId } from "../../catalog/index.ts";
import type { HushCommandReducer } from "./contracts.ts";
import { FILE_COMMAND_REDUCERS } from "./groups/file.ts";
import { JAVASCRIPT_COMMAND_REDUCERS } from "./groups/javascript.ts";
import { LANGUAGE_COMMAND_REDUCERS } from "./groups/language.ts";
import { OPERATION_COMMAND_REDUCERS } from "./groups/operation.ts";
import { VERSION_CONTROL_COMMAND_REDUCERS } from "./groups/version-control.ts";

const HUSH_COMMAND_REDUCERS = {
  ...FILE_COMMAND_REDUCERS,
  ...VERSION_CONTROL_COMMAND_REDUCERS,
  ...JAVASCRIPT_COMMAND_REDUCERS,
  ...LANGUAGE_COMMAND_REDUCERS,
  ...OPERATION_COMMAND_REDUCERS,
} as const satisfies Record<HushCatalogReducerId, HushCommandReducer>;

export const HUSH_COMMAND_REDUCER_IDS = Object.keys(
  HUSH_COMMAND_REDUCERS,
) as readonly HushCatalogReducerId[];

export function commandReducerFor(reducerId: string): HushCommandReducer | null {
  if (!Object.hasOwn(HUSH_COMMAND_REDUCERS, reducerId)) return null;
  return HUSH_COMMAND_REDUCERS[reducerId as HushCatalogReducerId];
}
