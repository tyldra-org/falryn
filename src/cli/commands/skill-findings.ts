/**
 * Skill validity findings for one-shot CLI commands (#1124). Composes the same
 * instruction-source owner a turn uses, publishes the current discovery generation
 * once, and derives findings from it. Stored admission refusals come from the skill
 * usage report; no model, MCP server, script or network is touched.
 */
import {
  createSkillFindings,
  refusalKey,
  type SkillFindingsCollection,
} from "../../application/extensions/skill-findings.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { primaryWorkspaceRoot } from "../../domain/workspace/workspace-set.ts";
import { composeInstructionSources } from "../runtime/instruction-sources.ts";
import { mcpConfiguration } from "../runtime/mcp-configuration.ts";
import {
  loadProductConfiguration,
  type ProductConfigurationLoadRequest,
} from "../runtime/product-configuration.ts";
import type { ServiceProvider } from "../runtime/services.ts";
import { runExtensionSkills } from "./extension-skills.ts";

export const DEFAULT_SKILL_FINDINGS_LOAD: ProductConfigurationLoadRequest = {
  profile: null,
  overrides: {},
};

export async function collectSkillFindings(
  services: ServiceProvider,
  request: ProductConfigurationLoadRequest,
  signal: AbortSignal,
): Promise<SkillFindingsCollection> {
  const graph = services();
  try {
    const loaded = await loadProductConfiguration(graph, request, signal);
    if (loaded.outcome.kind !== "published" && loaded.outcome.kind !== "unchanged")
      return { status: "unavailable", code: "configuration-unavailable" };
  } catch {
    return {
      status: "unavailable",
      code: signal.aborted ? "cancelled" : "configuration-unavailable",
    };
  }
  const workspace = await graph.ensureWorkspaceSet(signal);
  if (!workspace.ok) return { status: "unavailable", code: "workspace-unavailable" };
  const owner = composeInstructionSources(graph);
  const findings = createSkillFindings({
    owner,
    scope: {
      root: canonicalDigest({ root: primaryWorkspaceRoot(workspace.value.set).path }),
      directory: "",
      kind: "main",
    },
    diagnostics: owner.skillDiagnostics,
    workspaceTrust() {
      const current = graph.workspaceTrust.current();
      return { status: current.status, reason: current.reason };
    },
    mcpServers() {
      const record = graph.loader.current();
      try {
        const configured = mcpConfiguration(
          record?.values ?? {},
          Number(record?.generation ?? 0),
          record,
        );
        return new Set(
          configured.servers.filter((server) => server.enabled).map((server) => server.id),
        );
      } catch {
        return null;
      }
    },
    async refusals(historySignal) {
      const usage = await runExtensionSkills(services, {}, historySignal);
      const report = usage.payload;
      if (report === null || report.status !== "reported")
        return { ok: false, code: "admission-history-unavailable" };
      const refusals = new Map<string, Record<string, number>>();
      for (const row of report.rows) {
        if (row.source === null || row.digest === null || row.counts.refused === 0) continue;
        const key = refusalKey(row.source, row.digest);
        const reasons = refusals.get(key) ?? {};
        for (const [reason, count] of Object.entries(row.reasons))
          if (reason.startsWith("refused:"))
            reasons[reason.slice("refused:".length)] =
              (reasons[reason.slice("refused:".length)] ?? 0) + count;
        refusals.set(key, reasons);
      }
      return { ok: true, refusals, complete: report.coverage.complete && !report.cancelled };
    },
  });
  await findings.refresh(signal);
  if (signal.aborted) return { status: "unavailable", code: "cancelled" };
  return findings.collect(signal);
}
