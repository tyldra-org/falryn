/** Reducer entrypoints used by command rules. */

import { buildProjection } from "./build/reduce.ts";
import { compoundProjection } from "./compound/reduce.ts";
import type { HushReducer } from "./contracts.ts";
import { countProjection } from "./count/reduce.ts";
import { diagnosticProjection } from "./diagnostic/reduce.ts";
import { forgeProjection } from "./forge/reduce.ts";
import {
  gitDiffProjection,
  gitLogProjection,
  gitMutationProjection,
  gitStatusProjection,
} from "./git/index.ts";
import { curlProjection } from "./http/curl.ts";
import { wgetProjection } from "./http/wget.ts";
import { jsonProjection } from "./json/reduce.ts";
import { listingProjection } from "./listing/reduce.ts";
import { logProjection } from "./log/reduce.ts";
import { lsProjection } from "./ls/reduce.ts";
import { networkProjection } from "./network/reduce.ts";
import { operationProjection } from "./operation/reduce.ts";
import { packageProjection } from "./package/reduce.ts";
import { plainTextProjection } from "./plain-text.ts";
import { searchProjection } from "./search/reduce.ts";
import { structuredProjection } from "./structured/reduce.ts";
import { tableProjection } from "./table/reduce.ts";
import { testProjection } from "./test/reduce.ts";
import { transformProjection } from "./transform/reduce.ts";
import { treeProjection } from "./tree/reduce.ts";

export const reduceLs: HushReducer = ({ capture, maxBytes, patterns }) =>
  lsProjection(capture, maxBytes, patterns);

export const reduceTree: HushReducer = ({ capture, maxBytes, patterns, commandTokens }) =>
  treeProjection(capture, maxBytes, patterns, commandTokens);

export const reduceListing: HushReducer = ({ capture, maxBytes, patterns, commandTokens }) =>
  listingProjection(capture, maxBytes, patterns, commandTokens);

export const reduceRead: HushReducer = ({ capture, maxBytes, patterns }) =>
  plainTextProjection("read", capture, maxBytes, patterns);

export const reduceJson: HushReducer = ({ capture, maxBytes, patterns }) =>
  jsonProjection(capture, maxBytes, patterns);

export const reduceSearch: HushReducer = ({ capture, maxBytes, patterns }) =>
  searchProjection(capture, maxBytes, patterns);

export const reduceTransform: HushReducer = ({ capture, maxBytes, patterns }) =>
  transformProjection(capture, maxBytes, patterns);

export const reduceCount: HushReducer = ({ capture, maxBytes, patterns, commandTokens }) =>
  countProjection(capture, maxBytes, patterns, commandTokens);

export const reduceLog: HushReducer = ({ capture, maxBytes, patterns, commandTokens }) =>
  logProjection(capture, maxBytes, patterns, commandTokens);

export const reduceGitStatus: HushReducer = ({ capture, maxBytes, patterns }) =>
  gitStatusProjection(capture, maxBytes, patterns);

export const reduceGitDiff: HushReducer = ({ capture, maxBytes, patterns, commandTokens }) =>
  gitDiffProjection(capture, maxBytes, patterns, commandTokens);

export const reduceGitLog: HushReducer = ({ capture, maxBytes, patterns, commandTokens }) =>
  gitLogProjection(capture, maxBytes, patterns, commandTokens);

export const reduceGitMutation: HushReducer = ({
  capture,
  maxBytes,
  patterns,
  commandTokens,
  cwd,
}) => gitMutationProjection(capture, maxBytes, patterns, commandTokens, cwd);

export const reduceForge: HushReducer = ({ capture, maxBytes, patterns, commandTokens }) =>
  forgeProjection(capture, maxBytes, patterns, commandTokens);

export const reduceTest: HushReducer = ({ capture, maxBytes, patterns, commandTokens }) =>
  testProjection(capture, maxBytes, patterns, commandTokens);

export const reduceDiagnostic: HushReducer = ({ capture, maxBytes, patterns, commandTokens }) =>
  diagnosticProjection(capture, maxBytes, patterns, commandTokens);

export const reduceBuild: HushReducer = ({ capture, maxBytes, patterns, commandTokens }) =>
  buildProjection(capture, maxBytes, patterns, commandTokens);

export const reducePackage: HushReducer = ({ capture, maxBytes, patterns, commandTokens }) =>
  packageProjection(capture, maxBytes, patterns, commandTokens);

export const reduceTable: HushReducer = ({ capture, maxBytes, patterns, commandTokens }) =>
  tableProjection(capture, maxBytes, patterns, commandTokens);

export const reduceCurl: HushReducer = ({ capture, maxBytes, patterns }) =>
  curlProjection(capture, maxBytes, patterns);

export const reduceWget: HushReducer = ({ capture, maxBytes, patterns, commandTokens }) =>
  wgetProjection(capture, maxBytes, patterns, commandTokens);

export const reduceNetwork: HushReducer = ({ capture, maxBytes, patterns, commandTokens }) =>
  networkProjection(capture, maxBytes, patterns, commandTokens);

export const reduceOperation: HushReducer = ({ capture, maxBytes, patterns, commandTokens }) =>
  operationProjection(capture, maxBytes, patterns, commandTokens);

export const reduceStructured: HushReducer = ({ capture, maxBytes, patterns, commandTokens }) =>
  structuredProjection(capture, maxBytes, patterns, commandTokens);

export const reduceCompound: HushReducer = ({ capture, maxBytes, patterns, commandSegments }) =>
  compoundProjection(capture, maxBytes, patterns, commandSegments);
