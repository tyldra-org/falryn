/** Hush policies covering the pinned RTK host-executable baseline. */

import type { HushCatalogEntry, HushCommandPolicy } from "./contracts.ts";
import { FILE_COMMANDS } from "./files.ts";
import { JAVASCRIPT_COMMANDS } from "./javascript.ts";
import { LANGUAGE_COMMANDS } from "./languages.ts";
import { OPERATION_COMMANDS } from "./operations.ts";
import { VERSION_CONTROL_COMMANDS } from "./version-control.ts";

export type {
  HushCatalogEntry,
  HushCommandClassification,
  HushCommandPolicy,
  HushProjectionKind,
} from "./contracts.ts";

export const HUSH_COMMAND_CATALOG = [
  ...FILE_COMMANDS,
  ...VERSION_CONTROL_COMMANDS,
  ...JAVASCRIPT_COMMANDS,
  ...LANGUAGE_COMMANDS,
  ...OPERATION_COMMANDS,
] as const satisfies readonly HushCatalogEntry[];

const CATALOG_BY_EXECUTABLE = commandIndex(HUSH_COMMAND_CATALOG);

export const SHELL_COMPOUND_POLICY: HushCommandPolicy = {
  family: "generic",
  reducerId: "shell.compound",
  projection: "operation",
};

export function matchHushCommand(tokens: readonly string[]): HushCommandPolicy | null {
  const executable = tokens[0];
  if (executable === undefined) {
    return null;
  }
  const entries = CATALOG_BY_EXECUTABLE.get(executable);
  if (entries === undefined) {
    return null;
  }
  for (const entry of entries) {
    if (entry.matches?.(tokens) ?? true) {
      return {
        family: entry.family,
        reducerId: entry.reducerId,
        projection: entry.projection,
      };
    }
  }
  return null;
}

function commandIndex(
  catalog: readonly HushCatalogEntry[],
): ReadonlyMap<string, readonly HushCatalogEntry[]> {
  const mutable = new Map<string, HushCatalogEntry[]>();
  for (const entry of catalog) {
    for (const executable of entry.executables) {
      const entries = mutable.get(executable) ?? [];
      entries.push(entry);
      mutable.set(executable, entries);
    }
  }
  return mutable;
}
