import type { ProductResources } from "../../application/orchestration/product-resources.ts";
/** Binds the shared export action to the active shell session. */
import type { SessionExportControl } from "../../application/sessions/session-export.ts";
import type { SessionId } from "../../domain/foundation/index.ts";
import { exportName } from "../../domain/sessions/index.ts";
import type { ServiceProvider } from "../runtime/services.ts";
import { runExport } from "./export.ts";
export function sessionExportControl(
  services: ServiceProvider,
  session: SessionId,
  resources?: ProductResources,
): SessionExportControl {
  return async (argument, signal) => {
    const input = argument?.trim() ?? "";
    const write = input.startsWith("write ");
    const parsed = write ? exportName.parse(input.slice(6).trim()) : null;
    if ((input !== "" && input !== "preview" && !write) || (write && !parsed?.ok))
      return {
        message:
          "Use /export to preview the current session, or /export write <package-name> for a versioned JSONL package with authorized artifacts. Existing destinations are never overwritten.",
      };
    const result = await runExport(
      services,
      {
        selection: { kind: "sessions", sessionIds: [session], includeSensitive: false },
        write,
        name: parsed?.ok ? parsed.value : null,
      },
      signal,
      undefined,
      resources,
    );
    if (!result.payload)
      return {
        message: `Export ${result.outcome.kind}: ${result.errors.map((error) => error.code).join(", ") || "unavailable"}.`,
      };
    const payload = result.payload;
    return {
      message: `${payload.mode === "preview" ? "Export preview" : "Export written"}: ${payload.counts.events} events, ${payload.counts.artifacts} artifacts, ${payload.omissions.length} omissions, ${payload.redactions.length} redactions.${payload.bundle === null ? " Use /export write <package-name> to write this session as versioned JSONL with authorized artifacts." : ` Package: ${payload.bundle.name}; ${payload.bundle.byteLength} bytes.${payload.bundle.cancelledAfterFinalize ? " Cancellation arrived after publication." : ""}`}`,
    };
  };
}
