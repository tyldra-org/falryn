/** Ordered command-reducer group mirroring the Hush catalog. */

import { BUILD_GENERIC_REDUCER } from "../build/generic.ts";
import { DATA_JSON_REDUCER } from "../data/json.ts";
import { FILES_COUNT_REDUCER } from "../files/count.ts";
import { FILES_DIFF_REDUCER } from "../files/diff.ts";
import { FILES_FIND_REDUCER } from "../files/find.ts";
import { FILES_GREP_REDUCER } from "../files/grep.ts";
import { FILES_LS_REDUCER } from "../files/ls.ts";
import { FILES_READ_REDUCER } from "../files/read.ts";
import { FILES_RG_REDUCER } from "../files/rg.ts";
import { FILES_TAIL_REDUCER } from "../files/tail.ts";
import { FILES_TREE_REDUCER } from "../files/tree.ts";
import { FORMAT_GENERIC_REDUCER } from "../format/generic.ts";
import { TEST_GENERIC_REDUCER } from "../test/generic.ts";
import { TRANSFORM_LOG_REDUCER } from "../transform/log.ts";
import { TRANSFORM_SED_REDUCER } from "../transform/sed.ts";
import { TRANSFORM_SUMMARY_REDUCER } from "../transform/summary.ts";

export const FILE_COMMAND_REDUCERS = {
  "files.ls": FILES_LS_REDUCER,
  "files.tree": FILES_TREE_REDUCER,
  "files.find": FILES_FIND_REDUCER,
  "files.read": FILES_READ_REDUCER,
  "files.tail": FILES_TAIL_REDUCER,
  "files.rg": FILES_RG_REDUCER,
  "files.grep": FILES_GREP_REDUCER,
  "transform.sed": TRANSFORM_SED_REDUCER,
  "files.diff": FILES_DIFF_REDUCER,
  "files.count": FILES_COUNT_REDUCER,
  "data.json": DATA_JSON_REDUCER,
  "transform.log": TRANSFORM_LOG_REDUCER,
  "transform.summary": TRANSFORM_SUMMARY_REDUCER,
  "test.generic": TEST_GENERIC_REDUCER,
  "format.generic": FORMAT_GENERIC_REDUCER,
  "build.generic": BUILD_GENERIC_REDUCER,
} as const;
