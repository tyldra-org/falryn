/** Shared projection adapters for test, diagnostic, build, package, and operation reducers. */

import { buildProjection } from "../../build/projection.ts";
import { diagnosticProjection } from "../../diagnostic/projection.ts";
import { operationProjection } from "../../operation/projection.ts";
import { packageProjection } from "../../package/projection.ts";
import { testProjection } from "../../test/projection.ts";
import type { HushCommandReducer } from "../contracts.ts";

export const testReducer: HushCommandReducer = ({ capture, maxBytes, patterns, commandTokens }) =>
  testProjection(capture, maxBytes, patterns, commandTokens);

export const diagnosticReducer: HushCommandReducer = ({
  capture,
  maxBytes,
  patterns,
  commandTokens,
}) => diagnosticProjection(capture, maxBytes, patterns, commandTokens);

export const buildReducer: HushCommandReducer = ({ capture, maxBytes, patterns, commandTokens }) =>
  buildProjection(capture, maxBytes, patterns, commandTokens);

export const packageReducer: HushCommandReducer = ({
  capture,
  maxBytes,
  patterns,
  commandTokens,
}) => packageProjection(capture, maxBytes, patterns, commandTokens);

export const operationReducer: HushCommandReducer = ({
  capture,
  maxBytes,
  patterns,
  commandTokens,
}) => operationProjection(capture, maxBytes, patterns, commandTokens);
