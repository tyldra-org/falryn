/** Human projections for provider management and coding runs. */

import type { CodingRunPayload, ProviderCommandPayload } from "../commands.ts";
import type { RenderedPayload } from "./payload.ts";
import { paint, type Session } from "./session.ts";
import { safe } from "./text.ts";

export function renderProviderConnections(
  session: Session,
  payload: ProviderCommandPayload | null,
): RenderedPayload {
  if (payload === null) {
    return { lines: ["No provider connection result is available."], diagnostics: [] };
  }
  if (payload.kind === "failed") {
    return {
      lines: [],
      diagnostics: [`Provider ${safe(payload.action)} failed: ${safe(payload.issue.code)}`],
    };
  }
  const lines = [
    paint(session, "plain", `Provider ${safe(payload.action)}`),
    `  Selected  ${safe(payload.selectedProfileId ?? "(none)")}`,
  ];
  for (const connection of payload.connections) {
    const selected = connection.selected ? "*" : " ";
    const auth = connection.credentialConfigured
      ? `configured:${connection.credentialStore ?? "reference"}`
      : "not configured";
    lines.push(
      `${selected} ${safe(connection.profileId)}  ${safe(connection.displayName)}  ${safe(auth)}`,
      `    ${safe(connection.adapterKind)}  ${safe(connection.endpoint ?? "default endpoint")}`,
      `    models: ${connection.models.map(safe).join(", ") || "(none)"}`,
    );
    if (connection.catalogs.length > 0) {
      lines.push(`    catalogs: ${connection.catalogs.map(safe).join(", ")}`);
    }
  }
  if (payload.catalog !== null) {
    lines.push(`  Catalog   ${payload.catalog.models.length} models`);
  }
  if (payload.discovery.kind === "failed") {
    lines.push(`  Discovery unavailable: ${safe(payload.discovery.code)}`);
  }
  if (payload.auth !== null) {
    lines.push(`  Auth      ${safe(payload.auth.state)}`);
  }
  if (payload.revocation !== null) {
    lines.push(
      `  Logout    local=${safe(payload.revocation.local)} remote=${safe(payload.revocation.remote)}`,
    );
  }
  return { lines, diagnostics: [] };
}

export function renderCodingRun(
  session: Session,
  payload: CodingRunPayload | null,
): RenderedPayload {
  if (payload === null) {
    return { lines: ["No coding run result is available."], diagnostics: [] };
  }
  const lines = [
    paint(session, "plain", "Coding run"),
    `  Prompt       ${safe(payload.prompt === "" ? "(none)" : payload.prompt)}`,
    `  Stage        ${safe(payload.stage)}`,
    `  Session      ${safe(payload.sessionId === "" ? "(none)" : payload.sessionId)}`,
    `  Turn         ${safe(payload.turnId === null ? "(none)" : payload.turnId)}`,
    `  Workspace    ${safe(payload.workspaceId === "" ? "(none)" : payload.workspaceId)}`,
    `  Events       ${payload.eventCount}`,
  ];
  if (payload.executionProfile !== undefined) {
    lines.push(
      `  Mode         ${safe(payload.executionProfile)}  completion=${safe(payload.completionCriterion ?? "unknown")}`,
      `  Model role   ${safe(payload.effectiveModelRole ?? "unavailable")}  reasoning=${safe(payload.effectiveReasoning ?? "unavailable")}`,
    );
  }
  if (payload.planArtifactId !== undefined && payload.planArtifactId !== null) {
    lines.push(`  Plan artifact ${safe(payload.planArtifactId)}`);
  }
  if (payload.response !== undefined && payload.response.length > 0) {
    lines.push("", paint(session, "plain", "Response"), payload.response);
  }
  if (payload.modelAttempts !== undefined) {
    lines.push(
      `  Attempts     ${payload.modelAttempts}`,
      `  Tool results ${payload.toolResults ?? 0}`,
      `  Tools shown  ${payload.disclosedTools ?? 0}`,
    );
  }
  return { lines, diagnostics: [] };
}
