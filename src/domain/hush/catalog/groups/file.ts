/** Ordered Hush catalog group preserving executable matcher precedence. */

import { BUILD_GENERIC_POLICY } from "../build/generic.ts";
import type { HushCatalogEntry } from "../contracts.ts";
import { DATA_JSON_POLICY } from "../data/json.ts";
import { FILES_COUNT_POLICY } from "../files/count.ts";
import { FILES_DIFF_POLICY } from "../files/diff.ts";
import { FILES_FIND_POLICY } from "../files/find.ts";
import { FILES_GREP_POLICY } from "../files/grep.ts";
import { FILES_LS_POLICY } from "../files/ls.ts";
import { FILES_READ_POLICY } from "../files/read.ts";
import { FILES_RG_POLICY } from "../files/rg.ts";
import { FILES_TAIL_POLICY } from "../files/tail.ts";
import { FILES_TREE_POLICY } from "../files/tree.ts";
import { FORMAT_GENERIC_POLICY } from "../format/generic.ts";
import { TEST_GENERIC_POLICY } from "../test/generic.ts";
import { TRANSFORM_LOG_POLICY } from "../transform/log.ts";
import { TRANSFORM_SED_POLICY } from "../transform/sed.ts";
import { TRANSFORM_SUMMARY_POLICY } from "../transform/summary.ts";

export const FILE_COMMANDS = [
  FILES_LS_POLICY,
  FILES_TREE_POLICY,
  FILES_FIND_POLICY,
  FILES_READ_POLICY,
  FILES_TAIL_POLICY,
  FILES_RG_POLICY,
  FILES_GREP_POLICY,
  TRANSFORM_SED_POLICY,
  FILES_DIFF_POLICY,
  FILES_COUNT_POLICY,
  DATA_JSON_POLICY,
  TRANSFORM_LOG_POLICY,
  TRANSFORM_SUMMARY_POLICY,
  TEST_GENERIC_POLICY,
  FORMAT_GENERIC_POLICY,
  BUILD_GENERIC_POLICY,
] as const satisfies readonly HushCatalogEntry[];
