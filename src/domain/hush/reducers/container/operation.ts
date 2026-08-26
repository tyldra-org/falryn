/** Safe terminal-fact projections for container image operations. */

import { shortestText } from "../../text-format.ts";
import { containerExecutable, containerLines, containerSubcommand } from "./shared.ts";

type CopyProgress = Readonly<{
  blobs: readonly string[];
  config: string | null;
  manifest: boolean;
  signatures: boolean;
  terminalIdentity: string | null;
}>;

export function formatContainerOperationOutput(
  text: string,
  commandTokens: readonly string[],
): string | null {
  const executable = containerExecutable(commandTokens);
  const subcommand = containerSubcommand(commandTokens);
  if (subcommand === "run" || subcommand === "exec") return null;
  if (executable === "skopeo" && subcommand === "copy") {
    return formatCopyProgress(text, "skopeo copy");
  }
  if ((executable === "docker" || executable === "podman") && subcommand === "pull") {
    return formatDockerPull(text, executable) ?? formatCopyProgress(text, `${executable} pull`);
  }
  return null;
}

function formatDockerPull(text: string, executable: string): string | null {
  const layers = new Map<string, string>();
  let digest: string | null = null;
  let status: string | null = null;
  let image: string | null = null;
  for (const line of containerLines(text)) {
    if (/^\S+: Pulling from \S+$/u.test(line)) continue;
    const layer = /^([a-f0-9]+): (.+)$/u.exec(line);
    if (layer !== null) {
      layers.set(layer[1] ?? "", layer[2] ?? "");
      continue;
    }
    const digestLine = /^Digest:\s+(sha256:[a-f0-9]+)$/u.exec(line);
    if (digestLine !== null) {
      digest = digestLine[1] ?? null;
      continue;
    }
    const statusLine = /^Status:\s+(.+)$/u.exec(line);
    if (statusLine !== null) {
      status = statusLine[1] ?? null;
      continue;
    }
    if (/^(?:docker\.io|localhost|[\w.-]+:\d+)\//u.test(line)) {
      image = line;
      continue;
    }
    return null;
  }
  if (digest === null || status === null || image === null || layers.size === 0) return null;
  const layerSummary = [...layers].map(([id, state]) => `${id}=${state}`).join(", ");
  const formatted = [
    `ok ${executable} pull ${image}@${digest}`,
    `layers ${layers.size}: ${layerSummary}`,
    status,
  ].join("\n");
  return shortestText(text, formatted);
}

function formatCopyProgress(text: string, label: string): string | null {
  const blobs: string[] = [];
  let config: string | null = null;
  let manifest = false;
  let signatures = false;
  let terminalIdentity: string | null = null;
  for (const line of containerLines(text)) {
    if (/^(?:Trying to pull|Getting image source signatures)/u.test(line)) continue;
    const blob = /^Copying blob\s+(sha256:[a-f0-9]+)(?:\s+.*)?$/u.exec(line);
    if (blob !== null) {
      blobs.push(blob[1] ?? "");
      continue;
    }
    const configLine = /^Copying config\s+(sha256:[a-f0-9]+)(?:\s+.*)?$/u.exec(line);
    if (configLine !== null) {
      config = configLine[1] ?? null;
      continue;
    }
    if (line === "Writing manifest to image destination") {
      manifest = true;
      continue;
    }
    if (line === "Storing signatures") {
      signatures = true;
      continue;
    }
    if (/^sha256:[a-f0-9]+$/u.test(line)) {
      terminalIdentity = line;
      continue;
    }
    return null;
  }
  const progress: CopyProgress = { blobs, config, manifest, signatures, terminalIdentity };
  if (
    progress.blobs.length === 0 ||
    progress.config === null ||
    !progress.manifest ||
    !progress.signatures
  ) {
    return null;
  }
  const formatted = [
    `ok ${label} ${progress.blobs.length} blobs`,
    progress.blobs.join(", "),
    `config ${progress.config}; manifest; signatures${
      progress.terminalIdentity === null ? "" : `; ${progress.terminalIdentity}`
    }`,
  ].join("\n");
  return shortestText(text, formatted);
}
