/** One human-facing control plane for Brief, Hush, and Loom. */

import type {
  ProductBriefControls,
  ProductBriefFrontendMode,
  ProductEngineFrontendState,
  ProductOutputControls,
} from "../application/index.ts";

export const COMPRESSION_CONTROL_ACTIONS = [
  "brief.auto",
  "brief.compact",
  "brief.balanced",
  "brief.detailed",
  "brief.off",
  "hush.toggle",
  "loom.toggle",
  "all.on",
  "all.off",
] as const;

export type CompressionControlAction = (typeof COMPRESSION_CONTROL_ACTIONS)[number];

export type CompressionControlState = {
  readonly brief: ProductBriefFrontendMode | null;
  readonly hush: ProductEngineFrontendState | null;
  readonly loom: ProductEngineFrontendState | null;
};

export function compressionControlState(
  brief: ProductBriefControls | null,
  output: ProductOutputControls | null,
): CompressionControlState {
  return {
    brief: brief?.getFrontendMode() ?? null,
    hush: output?.getHushState() ?? null,
    loom: output?.getLoomState() ?? null,
  };
}

/** Apply one overlay action through the same controls used by the slash shortcuts. */
export function applyCompressionControl(
  brief: ProductBriefControls | null,
  output: ProductOutputControls | null,
  action: CompressionControlAction,
): string {
  if (action.startsWith("brief.")) {
    if (brief === null) return "Brief controls are not attached to this shell.";
    const mode = action.slice("brief.".length);
    const result = brief.setFrontendMode(mode);
    return result.ok ? `Brief set to ${brief.getFrontendMode()}.` : "Brief mode was refused.";
  }

  if (action === "hush.toggle") {
    if (output === null) return "Hush controls are not attached to this shell.";
    const next = output.getHushState() === "on" ? "off" : "on";
    output.setHushState(next);
    return `Hush set to ${next}.`;
  }

  if (action === "loom.toggle") {
    if (output === null) return "Loom controls are not attached to this shell.";
    const next = output.getLoomState() === "on" ? "off" : "on";
    output.setLoomState(next);
    return `Loom set to ${next}.`;
  }

  const enabled = action === "all.on";
  if (brief === null && output === null) {
    return "Compression controls are not attached to this shell.";
  }
  const changed: string[] = [];
  if (brief !== null) {
    brief.setFrontendMode(enabled ? "on" : "off");
    changed.push("Brief");
  }
  if (output !== null) {
    output.setHushState(enabled ? "on" : "off");
    output.setLoomState(enabled ? "on" : "off");
    changed.push("Hush", "Loom");
  }
  const names = listNames(changed);
  if (enabled) return `${names} enabled.`;
  return `${names} ${changed.length === 1 ? "is" : "are"} off.`;
}

function listNames(names: readonly string[]): string {
  if (names.length < 2) return names[0] ?? "Compression";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}
