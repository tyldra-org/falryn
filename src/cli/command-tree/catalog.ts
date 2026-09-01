/** Artifact and workspace argument normalization. */

import {
  artifactId,
  DEFAULT_ARTIFACT_LIST_LIMIT,
  DEFAULT_WORKSPACE_LAYOUT_LIST_LIMIT,
  isLegalWorkspaceLayoutName,
  localPathTextError,
  MAX_ARTIFACT_CATALOG,
  MAX_LOCAL_PATH_LENGTH,
  MAX_WORKSPACE_LAYOUT_CATALOG,
} from "../../domain/index.ts";

import type {
  ArtifactCommandArguments,
  RawArguments,
  RunnableCommand,
  WorkspaceCommandArguments,
} from "./contracts.ts";

export function artifactArgumentsFor(
  command: RunnableCommand,
  parsed: RawArguments,
): ArtifactCommandArguments | null | string {
  if (command !== "artifact.list" && command !== "artifact.show" && command !== "artifact.get") {
    return null;
  }

  if (command === "artifact.list") {
    if (parsed.id !== undefined) {
      return "Argument id is only valid with artifact show or get.";
    }
    if (parsed.output !== undefined) {
      return "Argument output is only valid with artifact get.";
    }
    const limit = parsed.limit ?? DEFAULT_ARTIFACT_LIST_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ARTIFACT_CATALOG) {
      return `Argument limit must be a whole number from 1 to ${MAX_ARTIFACT_CATALOG}.`;
    }
    return { action: "list", limit };
  }

  if (parsed.limit !== undefined) {
    return "Argument limit is only valid with artifact list.";
  }

  if (parsed.id === undefined) {
    return "Argument id is required for artifact show and get.";
  }
  const parsedId = artifactId.parse(parsed.id);
  if (!parsedId.ok) {
    return "Argument id must be an artifact identity.";
  }

  if (command === "artifact.show") {
    if (parsed.output !== undefined) {
      return "Argument output is only valid with artifact get.";
    }
    return { action: "show", artifactId: parsedId.value };
  }

  const outputPath = parsed.output ?? null;
  if (outputPath !== null) {
    const pathIssue = outputPathIssue(outputPath);
    if (pathIssue !== null) {
      return pathIssue;
    }
  }
  return { action: "get", artifactId: parsedId.value, outputPath };
}

export function workspaceArgumentsFor(
  command: RunnableCommand,
  parsed: RawArguments,
): WorkspaceCommandArguments | null | string {
  if (
    command !== "workspace.list" &&
    command !== "workspace.show" &&
    command !== "workspace.save" &&
    command !== "workspace.load"
  ) {
    return null;
  }

  if (command === "workspace.list") {
    if (parsed.name !== undefined) {
      return "Argument name is only valid with workspace save or load.";
    }
    if (parsed.force === true) {
      return "Argument force is only valid with workspace save.";
    }
    const limit = parsed.limit ?? DEFAULT_WORKSPACE_LAYOUT_LIST_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_WORKSPACE_LAYOUT_CATALOG) {
      return `Argument limit must be a whole number from 1 to ${MAX_WORKSPACE_LAYOUT_CATALOG}.`;
    }
    return { action: "list", limit };
  }

  if (command === "workspace.show") {
    if (parsed.name !== undefined) {
      return "Argument name is only valid with workspace save or load.";
    }
    if (parsed.limit !== undefined) {
      return "Argument limit is only valid with workspace list.";
    }
    if (parsed.force === true) {
      return "Argument force is only valid with workspace save.";
    }
    return { action: "show" };
  }

  if (parsed.limit !== undefined) {
    return "Argument limit is only valid with workspace list.";
  }
  if (parsed.name === undefined) {
    return "Argument name is required for workspace save and load.";
  }
  if (!isLegalWorkspaceLayoutName(parsed.name)) {
    return "Argument name must be a legal layout name (same rule as --profile).";
  }

  if (command === "workspace.save") {
    return { action: "save", name: parsed.name, force: parsed.force === true };
  }

  if (parsed.force === true) {
    return "Argument force is only valid with workspace save.";
  }
  return { action: "load", name: parsed.name };
}

function outputPathIssue(value: string): string | null {
  const error = localPathTextError(value);
  if (error === null) {
    return null;
  }
  return error.code === "path-too-long"
    ? `Argument output: a destination path cannot exceed ${MAX_LOCAL_PATH_LENGTH} characters.`
    : "Argument output: the path contains a character that cannot appear in one.";
}

/**
 * The first conflicting combination, or `null` when there is none.
 *
 * Checked before dispatch, because `reference/CLI.md` requires incompatible
 * options to fail before application work. Each message names both flags, so
 * the reader does not have to guess which one to drop.
 */
