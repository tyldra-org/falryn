/** Typed command catalog contracts for Hush reducer selection. */

import type { HushCommandShape } from "../command-shape.ts";
import type { HushFamily } from "../contracts.ts";

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
  "log",
  "curl",
  "wget",
  "network",
  "operation",
  "structured",
] as const;

export type HushProjectionKind = (typeof HUSH_PROJECTION_KINDS)[number];

export type HushCommandPolicy = {
  readonly family: HushFamily;
  readonly reducerId: string;
  readonly projection: HushProjectionKind;
};

export type HushCatalogEntry = HushCommandPolicy & {
  readonly executables: readonly string[];
  readonly examples: readonly string[];
  readonly matches?: ((tokens: readonly string[]) => boolean) | undefined;
};

export type HushCommandClassification = HushCommandPolicy &
  HushCommandShape & {
    readonly matched: boolean;
  };
