/** Typed command catalog contracts for Hush reducer selection. */

import type { HushFamily } from "../contracts.ts";

export const HUSH_PROJECTION_KINDS = [
  "ls",
  "listing",
  "read",
  "search",
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

export type HushCommandClassification = HushCommandPolicy & {
  readonly tokens: readonly string[];
  readonly compound: boolean;
  readonly matched: boolean;
};
