/**
 * Which files each layer reads, and what reading them produced.
 *
 * Discovery reads bytes and executes nothing. It does not walk ancestors, does
 * not consult Git, and does not follow anything a file points at: the project
 * source is resolved from a workspace path the caller supplies, normalized and
 * bounded. Ancestor discovery and Git awareness belong to the workspace owner,
 * and a project configuration that could reach outside its own directory is a
 * checkout deciding what a machine reads.
 *
 * Every failure mode of a source — absent, empty, unreadable, oversized,
 * mis-encoded, malformed — is its own reported outcome rather than a crash or a
 * silent skip. A configuration file that was ignored without explanation is the
 * single most common configuration confusion there is.
 */

import {
  type ConfigurationIssue,
  type ConfigurationSource,
  type ConfigurationSourceKind,
  type FileSystemPort,
  joinPath,
  type LocalPath,
  MAX_CONFIGURATION_KEY_PATH_LENGTH,
  type SourceOutcome,
  type SourcePosition,
} from "../domain/index.ts";
import { MAX_CONFIGURATION_FILE_BYTES, parseJsonc } from "./jsonc.ts";

/** The file name every configuration layer uses. */
export const CONFIGURATION_FILE_NAME = "falryn.jsonc";

/** The directory a project's configuration lives in, relative to its root. */
export const PROJECT_CONFIGURATION_DIRECTORY = ".falryn";

/** Where profile files live under the configuration root. */
export const PROFILE_DIRECTORY = "profiles";

/** Longest a profile name may be, and the characters it may use. */
export const MAX_PROFILE_NAME_LENGTH = 64;

const LEGAL_PROFILE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export type DiscoveryInputs = {
  /** The configuration root, resolved by the local-data owner. */
  readonly configurationRoot: LocalPath;
  /** The workspace root, already normalized by the caller. `null` for none. */
  readonly workspaceRoot: LocalPath | null;
  /** The selected profile name, or `null`. */
  readonly profile: string | null;
};

export type DiscoveredSource = {
  readonly source: ConfigurationSource;
  readonly file: LocalPath;
};

/**
 * The file sources, in precedence order.
 *
 * Environment and CLI are layers too, but they read no file, so they are not
 * discovered — they are supplied.
 */
export function discoverSources(inputs: DiscoveryInputs): {
  readonly sources: readonly DiscoveredSource[];
  readonly issues: readonly ConfigurationIssue[];
} {
  const sources: DiscoveredSource[] = [];
  const issues: ConfigurationIssue[] = [];

  const userFile = joinPath(inputs.configurationRoot, CONFIGURATION_FILE_NAME);
  if (userFile.ok) {
    sources.push({
      source: { kind: "user-file", file: userFile.value, profile: null },
      file: userFile.value,
    });
  }

  if (inputs.workspaceRoot !== null) {
    const projectFile = joinPath(
      inputs.workspaceRoot,
      PROJECT_CONFIGURATION_DIRECTORY,
      CONFIGURATION_FILE_NAME,
    );
    if (projectFile.ok) {
      sources.push({
        source: { kind: "project-file", file: projectFile.value, profile: null },
        file: projectFile.value,
      });
    }
  }

  if (inputs.profile !== null) {
    if (!isLegalProfileName(inputs.profile)) {
      // Reported rather than sanitized: a profile name is a file name, and
      // quietly rewriting one would load a different profile than was asked for.
      issues.push({
        kind: "invalid-value",
        severity: "error",
        path: "profile",
        allowed: [],
      });
    } else {
      const profileFile = joinPath(
        inputs.configurationRoot,
        PROFILE_DIRECTORY,
        `${inputs.profile}.jsonc`,
      );
      if (profileFile.ok) {
        sources.push({
          source: { kind: "profile", file: profileFile.value, profile: inputs.profile },
          file: profileFile.value,
        });
      }
    }
  }

  return { sources, issues };
}

export function isLegalProfileName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_PROFILE_NAME_LENGTH && LEGAL_PROFILE_NAME.test(name);
}

export type ReadSource = {
  readonly source: ConfigurationSource;
  readonly outcome: SourceOutcome;
  /** The parsed document, present only when the outcome is `loaded`. */
  readonly document: unknown;
  readonly issues: readonly ConfigurationIssue[];
  /** Where parsing failed, or `null`. */
  readonly position: SourcePosition | null;
};

/**
 * Reads and parses one discovered source.
 *
 * Nothing here throws. A source that could not be read contributes no values
 * and reports why; whether that refuses the whole load is the loader's
 * decision, not this function's. Reading is separated from deciding precisely
 * so that "the file is missing" and "the file is wrong" can be answered
 * differently.
 */
export async function readSource(
  fileSystem: FileSystemPort,
  discovered: DiscoveredSource,
  signal?: AbortSignal,
): Promise<ReadSource> {
  const base = { source: discovered.source, document: undefined, position: null };

  const text = await fileSystem.readText(discovered.file, MAX_CONFIGURATION_FILE_BYTES, signal);

  if (!text.ok) {
    return { ...base, outcome: outcomeForRead(text.error.code), issues: [] };
  }

  if (text.value.trim().length === 0) {
    // An empty file is a deliberate act — it is what `> falryn.jsonc` leaves —
    // and it sets nothing without being an error.
    return { ...base, outcome: "empty", issues: [] };
  }

  const parsed = parseJsonc(text.value);
  if (!parsed.ok) {
    return {
      ...base,
      outcome: "malformed-syntax",
      position: parsed.error.position,
      issues: [
        {
          kind: "invalid-type",
          severity: "error",
          path: sourceLabel(discovered.source),
          expected: "object",
        },
      ],
    };
  }

  if (parsed.value === undefined) {
    // Comments and whitespace only.
    return { ...base, outcome: "empty", issues: [] };
  }

  return {
    source: discovered.source,
    outcome: "loaded",
    document: parsed.value,
    issues: [],
    position: null,
  };
}

function outcomeForRead(code: string): SourceOutcome {
  switch (code) {
    case "not-found":
      return "absent";
    case "oversized":
      return "oversized";
    case "malformed-encoding":
      return "malformed-encoding";
    default:
      return "unreadable";
  }
}

/**
 * A short label naming a source in a diagnostic.
 *
 * The file's own path, bounded. A user needs to know which of several files
 * was refused, and the path is the only thing that answers that — it is also
 * the user's own text, so it is bounded like every other path this build
 * reports.
 */
export function sourceLabel(source: ConfigurationSource): string {
  const label = source.file ?? source.kind;
  return label.length > MAX_CONFIGURATION_KEY_PATH_LENGTH
    ? label.slice(0, MAX_CONFIGURATION_KEY_PATH_LENGTH)
    : label;
}

/** Layers that read no file. */
export const SUPPLIED_LAYERS: readonly ConfigurationSourceKind[] = ["environment", "cli-override"];
