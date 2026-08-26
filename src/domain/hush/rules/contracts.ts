/** Contracts shared by Hush command rules and classification. */

import type { HushCommandShape } from "../command/normalize.ts";
import type { HushFamily } from "../contracts.ts";
import type { HushReducer } from "../reducers/contracts.ts";

export const HUSH_PROJECTION_KINDS = [
  "ls",
  "tree",
  "listing",
  "read",
  "json",
  "search",
  "transform",
  "compound",
  "git-status",
  "git-diff",
  "git-log",
  "git-mutation",
  "forge",
  "test",
  "diagnostic",
  "build",
  "package",
  "table",
  "count",
  "log",
  "curl",
  "wget",
  "network",
  "operation",
  "structured",
] as const;

export type HushProjectionKind = (typeof HUSH_PROJECTION_KINDS)[number];
export type HushCommandMatcher = (tokens: readonly string[]) => boolean;

export type HushReductionRule = Readonly<{
  family: HushFamily;
  reducerId: string;
  projection: HushProjectionKind;
  reduce: HushReducer;
}>;

export type HushCommandRule = HushReductionRule &
  Readonly<{
    executables: readonly string[];
    examples: readonly string[];
    matches?: HushCommandMatcher | undefined;
  }>;

export type HushCommandClassification = HushReductionRule &
  HushCommandShape & {
    readonly matched: boolean;
  };

type HushRuleMetadata = Omit<HushCommandRule, "reduce">;

export function defineCommandRule<const Metadata extends HushRuleMetadata>(
  metadata: Metadata,
  reduce: HushReducer,
): Metadata & Readonly<{ reduce: HushReducer }> {
  return { ...metadata, reduce };
}
