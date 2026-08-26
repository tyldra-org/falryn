/** Shared projection adapters for VCS and forge reducers. */

import { forgeProjection } from "../../forge/projection.ts";
import {
  gitDiffProjection,
  gitLogProjection,
  gitMutationProjection,
  gitStatusProjection,
} from "../../git/index.ts";
import type { HushCommandReducer } from "../contracts.ts";

export const gitStatusReducer: HushCommandReducer = ({ capture, maxBytes, patterns }) =>
  gitStatusProjection(capture, maxBytes, patterns);

export const gitDiffReducer: HushCommandReducer = ({
  capture,
  maxBytes,
  patterns,
  commandTokens,
}) => gitDiffProjection(capture, maxBytes, patterns, commandTokens);

export const gitLogReducer: HushCommandReducer = ({ capture, maxBytes, patterns, commandTokens }) =>
  gitLogProjection(capture, maxBytes, patterns, commandTokens);

export const gitMutationReducer: HushCommandReducer = ({
  capture,
  maxBytes,
  patterns,
  commandTokens,
  cwd,
}) => gitMutationProjection(capture, maxBytes, patterns, commandTokens, cwd);

export const forgeReducer: HushCommandReducer = ({ capture, maxBytes, patterns, commandTokens }) =>
  forgeProjection(capture, maxBytes, patterns, commandTokens);
