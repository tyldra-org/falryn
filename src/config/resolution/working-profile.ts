/** Inert, bounded profile selection and ancestry over the ordinary source reader. */

import type { WorkingProfileSelection } from "../../domain/configuration/configuration-source.ts";
import type { ConfigurationIssue } from "../../domain/configuration/index.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import {
  baseName,
  type FileSystemPort,
  joinPath,
  type LocalPath,
} from "../../domain/workspace/index.ts";
import { configurationObject, organizedIssue } from "../document/organized.ts";
import { usesOrganizedConfiguration } from "../document/schema-family.ts";
import {
  type DiscoveryInputs,
  discoverSources,
  isLegalProfileName,
  PROFILE_DIRECTORY,
  parseSourceText,
  type ReadSource,
  readSource,
} from "./sources.ts";

export const MAX_PROFILE_ANCESTRY = 8;

export async function listWorkingProfiles(
  fileSystem: FileSystemPort,
  root: LocalPath,
  signal?: AbortSignal,
) {
  const directory = joinPath(root, PROFILE_DIRECTORY);
  if (!directory.ok) return { profiles: [], issues: [organizedIssue("profiles")] };
  const listed = await fileSystem.list(directory.value, signal);
  if (!listed.ok)
    return {
      profiles: [],
      issues: listed.error.code === "not-found" ? [] : [organizedIssue("profiles.unreadable")],
    };
  const profiles = listed.value
    .filter((entry) => entry.kind === "file" && baseName(entry.path).endsWith(".jsonc"))
    .map((entry) => ({
      id: baseName(entry.path).slice(0, -6),
      file: entry.path,
      revision: entry.revision,
    }))
    .filter((entry) => isLegalProfileName(entry.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const names = new Set<string>();
  const issues: ConfigurationIssue[] = [];
  for (const profile of profiles) {
    const folded = profile.id.toLowerCase();
    if (names.has(folded)) issues.push(organizedIssue("profiles.ambiguous-case"));
    names.add(folded);
  }
  return { profiles, issues };
}

export async function readWorkingSources(
  fileSystem: FileSystemPort,
  request: DiscoveryInputs & {
    readonly projectText?: string | null;
    readonly privateProjectText?: string | null;
    readonly workspaceProfile?: string | null;
  },
  signal?: AbortSignal,
): Promise<{
  readonly reads: readonly ReadSource[];
  readonly issues: readonly ConfigurationIssue[];
  readonly selection: WorkingProfileSelection;
}> {
  const discovery = discoverSources({ ...request, profile: null });
  const issues: ConfigurationIssue[] = [...discovery.issues];
  const reads: ReadSource[] = [];
  for (const discovered of discovery.sources) {
    const text = discovered.source.kind === "project-file" ? request.projectText : undefined;
    reads.push(
      text === undefined
        ? await readSource(fileSystem, discovered, signal)
        : parseSourceText(
            {
              ...discovered,
              source: {
                ...discovered.source,
                revision: text === null ? null : canonicalDigest({ text }),
              },
            },
            text,
          ),
    );
  }
  const global = reads.find((read) => read.source.kind === "user-file")?.document;
  const profiles =
    configurationObject(global) && usesOrganizedConfiguration(global) ? global.profiles : undefined;
  const saved = configurationObject(profiles) ? profiles.default : undefined;
  const selectedBy =
    request.profile !== null
      ? "explicit"
      : request.workspaceProfile != null
        ? "workspace"
        : saved !== undefined
          ? "global"
          : "built-in";
  const selected = request.profile ?? request.workspaceProfile ?? saved ?? "default";
  const id = typeof selected === "string" && isLegalProfileName(selected) ? selected : "default";
  if (selected !== id) issues.push(organizedIssue("profiles.selection"));
  // Private project sources share project scope and the caller's trust decision.
  if (request.workspaceRoot !== null) {
    const path = joinPath(request.workspaceRoot, ".falryn", "local", "falryn.local.jsonc");
    if (path.ok) {
      const discovered = {
        file: path.value,
        source: { kind: "private-project-file" as const, file: path.value, profile: null },
      };
      const text =
        request.privateProjectText !== undefined
          ? request.privateProjectText
          : request.projectText === null
            ? null
            : undefined;
      const read =
        text === undefined
          ? await readSource(fileSystem, discovered, signal)
          : parseSourceText(
              {
                ...discovered,
                source: {
                  ...discovered.source,
                  revision: text === null ? null : canonicalDigest({ text }),
                },
              },
              text,
            );
      if (read.outcome !== "absent") reads.push(read);
    }
  }
  const catalog = await listWorkingProfiles(fileSystem, request.configurationRoot, signal);
  issues.push(...catalog.issues);
  const chain: ReadSource[] = [];
  const visited = new Set<string>();
  let current: string | null = id;
  let virtual = false;
  while (current !== null) {
    if (signal?.aborted) break;
    if (chain.length >= MAX_PROFILE_ANCESTRY || visited.has(current.toLowerCase())) {
      issues.push(organizedIssue("profiles.ancestry"));
      break;
    }
    visited.add(current.toLowerCase());
    if (
      catalog.profiles.some(
        (entry) => entry.id !== current && entry.id.toLowerCase() === current?.toLowerCase(),
      )
    ) {
      issues.push(organizedIssue("profiles.ambiguous-case"));
      break;
    }
    const source = discoverSources({ ...request, profile: current }).sources.find(
      (entry) => entry.source.kind === "profile",
    );
    if (source === undefined) {
      issues.push(organizedIssue("profiles.extends"));
      break;
    }
    const read = await readSource(fileSystem, source, signal);
    if (read.outcome === "absent" && current === "default" && chain.length === 0) {
      virtual = true;
      break;
    }
    chain.push(read);
    if (read.outcome !== "loaded" && read.outcome !== "empty") {
      issues.push(organizedIssue("profiles.selected-unavailable"));
      break;
    }
    const parent: unknown =
      configurationObject(read.document) && usesOrganizedConfiguration(read.document)
        ? read.document.extends
        : undefined;
    if (parent !== undefined && (typeof parent !== "string" || !isLegalProfileName(parent))) {
      issues.push(organizedIssue("profiles.extends"));
      break;
    }
    current = typeof parent === "string" ? parent : null;
  }
  chain.reverse();
  return {
    reads: [...reads, ...chain],
    issues,
    selection: {
      id,
      selectedBy,
      virtual,
      ancestry: chain.map((read) => ({
        id: read.source.profile ?? id,
        file: read.source.file as LocalPath,
        revision: read.source.revision ?? null,
      })),
    },
  };
}
