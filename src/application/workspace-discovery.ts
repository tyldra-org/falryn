/**
 * Bounded workspace path and glob discovery (#62).
 *
 * Binds the start path, walks through {@link createWorkspaceListing}, then
 * admits entries that match include globs and survive exclude/kind filters.
 * Descent never follows a symlink. File bytes, content search, `rg`, and
 * patches remain later #61 children.
 */

import {
  type FileSystemPort,
  globMatchesAny,
  isExcludedByGlobs,
  kindAdmitted,
  type LocalPath,
  parseWorkspaceDiscoveryRequest,
  type WorkspaceDiscoveryError,
  type WorkspaceDiscoveryResult,
  type WorkspaceEntry,
} from "../domain/index.ts";
import { createWorkspaceListing } from "./workspace-listing.ts";

export type WorkspaceDiscovery = {
  discover(
    root: LocalPath,
    request: unknown,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: WorkspaceDiscoveryResult }
    | { readonly ok: false; readonly error: WorkspaceDiscoveryError }
  >;
};

export function createWorkspaceDiscovery(fileSystem: FileSystemPort): WorkspaceDiscovery {
  const listing = createWorkspaceListing(fileSystem);
  return {
    async discover(root, request, signal) {
      const parsed = parseWorkspaceDiscoveryRequest(request);
      if (!parsed.ok) {
        return parsed;
      }
      const walked = await listing.walk(
        root,
        parsed.value.start,
        {
          includeHidden: parsed.value.includeHidden,
          maxEntries: parsed.value.maxWalkEntries,
          maxDepth: parsed.value.maxDepth,
        },
        signal,
      );
      if (!walked.ok) {
        return walked;
      }

      const matches: WorkspaceEntry[] = [];
      for (const entry of walked.value.entries) {
        if (!kindAdmitted(entry.kind, parsed.value.kinds)) {
          continue;
        }
        if (isExcludedByGlobs(entry.logical, entry.kind, parsed.value.exclude)) {
          continue;
        }
        if (!globMatchesAny(entry.logical, entry.kind, parsed.value.include)) {
          continue;
        }
        matches.push(entry);
        if (matches.length >= parsed.value.maxMatches) {
          return {
            ok: true,
            value: {
              start: walked.value.start,
              matches,
              failures: walked.value.failures,
              truncated: true,
              truncation: "match-limit",
            },
          };
        }
      }

      const truncated = walked.value.truncated;
      return {
        ok: true,
        value: {
          start: walked.value.start,
          matches,
          failures: walked.value.failures,
          truncated,
          truncation: truncated ? walked.value.truncation : null,
        },
      };
    },
  };
}
