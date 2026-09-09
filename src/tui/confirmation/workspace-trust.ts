import {
  WORKSPACE_LOADER_FAMILIES,
  type WorkspaceTrustReport,
} from "../../domain/security/workspace-trust.ts";
import type { ConfirmationPrompt } from "./prompt.ts";

export function workspaceTrustPrompt(report: WorkspaceTrustReport): ConfirmationPrompt {
  const generation = report.inventory?.generation ?? "unavailable";
  const families = WORKSPACE_LOADER_FAMILIES.map(
    (family) =>
      `${family}: ${report.inventory?.loaders.filter((loader) => loader.family === family).length ?? 0}`,
  ).join("; ");
  return {
    id: `workspace-trust-${generation}`,
    fingerprint: generation,
    title: "Review workspace trust",
    operation: `Project-local loader files. ${families}`,
    target: `Workspace ${report.inventory?.identity ?? "unavailable"}`,
    reason: `${report.reason}. ${report.added} added, ${report.changed} changed, ${report.removed} removed. File values are withheld.`,
    effect: "Proceed saves this generation and permits project settings to apply.",
    alternatives: [
      "Refuse keeps project loaders disabled and opens the shell for safe inspection.",
      "MCP, hooks, skills and instruction activation remain unavailable.",
      "Workspace approval is not an OS sandbox or a tool permission.",
      ...(report.inventory?.loaders.map(
        (loader) => `${loader.label}: ${loader.family}, ${loader.activation}`,
      ) ?? []),
      `Generation ${generation}`,
    ],
    scope: "workspace-generation",
    secret: null,
  };
}
