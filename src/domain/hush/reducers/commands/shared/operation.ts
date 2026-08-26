/** Shared projection adapters for system, structured, HTTP, and network reducers. */

import { curlProjection } from "../../http/curl.ts";
import { wgetProjection } from "../../http/wget.ts";
import { networkProjection } from "../../network/projection.ts";
import { structuredProjection } from "../../structured/projection.ts";
import { tableProjection } from "../../table/projection.ts";
import type { HushCommandReducer } from "../contracts.ts";

export const tableReducer: HushCommandReducer = ({ capture, maxBytes, patterns, commandTokens }) =>
  tableProjection(capture, maxBytes, patterns, commandTokens);

export const structuredReducer: HushCommandReducer = ({
  capture,
  maxBytes,
  patterns,
  commandTokens,
}) => structuredProjection(capture, maxBytes, patterns, commandTokens);

export const curlReducer: HushCommandReducer = ({ capture, maxBytes, patterns }) =>
  curlProjection(capture, maxBytes, patterns);

export const wgetReducer: HushCommandReducer = ({ capture, maxBytes, patterns, commandTokens }) =>
  wgetProjection(capture, maxBytes, patterns, commandTokens);

export const networkReducer: HushCommandReducer = ({
  capture,
  maxBytes,
  patterns,
  commandTokens,
}) => networkProjection(capture, maxBytes, patterns, commandTokens);
