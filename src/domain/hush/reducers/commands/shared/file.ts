/** Shared projection adapters for file, search, data, and log reducers. */

import { countProjection } from "../../count/projection.ts";
import { jsonProjection } from "../../json/projection.ts";
import { listingProjection } from "../../listing.ts";
import { logProjection } from "../../log/projection.ts";
import { lsProjection } from "../../ls/projection.ts";
import { searchProjection } from "../../search/projection.ts";
import { semanticProjection } from "../../semantic.ts";
import { transformProjection } from "../../transform/projection.ts";
import { treeProjection } from "../../tree/projection.ts";
import type { HushCommandReducer } from "../contracts.ts";

export const lsReducer: HushCommandReducer = ({ capture, maxBytes, patterns }) =>
  lsProjection(capture, maxBytes, patterns);

export const treeReducer: HushCommandReducer = ({ capture, maxBytes, patterns, commandTokens }) =>
  treeProjection(capture, maxBytes, patterns, commandTokens);

export const listingReducer: HushCommandReducer = ({
  capture,
  maxBytes,
  patterns,
  commandTokens,
}) => listingProjection(capture, maxBytes, patterns, commandTokens);

export const readReducer: HushCommandReducer = ({ capture, maxBytes, patterns }) =>
  semanticProjection("read", capture, maxBytes, patterns);

export const jsonReducer: HushCommandReducer = ({ capture, maxBytes, patterns }) =>
  jsonProjection(capture, maxBytes, patterns);

export const searchReducer: HushCommandReducer = ({ capture, maxBytes, patterns }) =>
  searchProjection(capture, maxBytes, patterns);

export const transformReducer: HushCommandReducer = ({ capture, maxBytes, patterns }) =>
  transformProjection(capture, maxBytes, patterns);

export const countReducer: HushCommandReducer = ({ capture, maxBytes, patterns, commandTokens }) =>
  countProjection(capture, maxBytes, patterns, commandTokens);

export const logReducer: HushCommandReducer = ({ capture, maxBytes, patterns, commandTokens }) =>
  logProjection(capture, maxBytes, patterns, commandTokens);
