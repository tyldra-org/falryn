/** One preview/write action for shell and headless session export. */
import { randomUUID } from "node:crypto";
import type { ExportName } from "../../domain/extensions/index.ts";
import { deadlineAt, instant, type Result } from "../../domain/foundation/index.ts";
import { conflictKey, NO_RETRY, workUnitId } from "../../domain/orchestration/index.ts";
import type {
  ExportError,
  ExportInventory,
  ExportResult,
  ExportSelection,
} from "../../domain/sessions/index.ts";
import type { ProductTaskResources } from "../orchestration/product-resources.ts";

export type SessionExportRequest = { readonly selection: ExportSelection } & (
  | { readonly mode: "preview" }
  | { readonly mode: "write"; readonly name: ExportName }
);
export type SessionExportOutcome =
  | {
      readonly kind: "ready";
      readonly inventory: ExportInventory;
      readonly written: ExportResult | null;
    }
  | { readonly kind: "failed"; readonly error: ExportError }
  | {
      readonly kind: "unavailable";
      readonly reason: string;
      readonly effect: "none" | "uncertain";
    };
export type SessionExportPort = {
  inventory(
    selection: ExportSelection,
    signal: AbortSignal,
  ): Promise<Result<ExportInventory, ExportError>>;
  write(
    name: ExportName,
    selection: ExportSelection,
    inventory: ExportInventory,
    signal: AbortSignal,
  ): Promise<Result<ExportResult, ExportError>>;
};
export function createSessionExportAction(port: SessionExportPort) {
  return {
    async run(
      request: SessionExportRequest,
      resources: ProductTaskResources,
      signal = new AbortController().signal,
    ): Promise<SessionExportOutcome> {
      const operation = `session-export:${randomUUID()}`;
      let writing = false;
      const executed = await resources.execute<SessionExportOutcome>({
        operation,
        attempt: operation,
        generation: resources.generation,
        signal,
        unit: {
          id: workUnitId(operation),
          effect: request.mode === "preview" ? "observation" : "mutation",
          priority: "interactive",
          conflictKeys: [
            conflictKey(
              "session-export",
              request.mode === "write" ? String(request.name) : operation,
            ),
          ],
          dependencies: [],
          deadline: deadlineAt(instant(Math.min(Date.now() + 30_000, resources.expiresAt))),
          expectedOutputBytes: 1024 * 1024,
          retry: NO_RETRY,
          scopeId: null,
        },
        inputBytes: Buffer.byteLength(JSON.stringify(request)),
        amounts: { operations: 1, bufferedBytes: 3 * 1024 * 1024, bufferedItems: 3 },
        async run(admittedSignal) {
          let value: SessionExportOutcome;
          try {
            const inventory = await port.inventory(request.selection, admittedSignal);
            if (!inventory.ok) value = { kind: "failed", error: inventory.error };
            else if (request.mode === "preview")
              value = { kind: "ready", inventory: inventory.value, written: null };
            else {
              writing = true;
              const written = await port.write(
                request.name,
                request.selection,
                inventory.value,
                admittedSignal,
              );
              value = written.ok
                ? { kind: "ready", inventory: inventory.value, written: written.value }
                : { kind: "failed", error: written.error };
            }
          } catch {
            value = {
              kind: "unavailable",
              reason: "export-operation-interrupted",
              effect: writing ? "uncertain" : "none",
            };
          }
          return {
            value,
            terminated: true,
            observedEffect:
              value.kind === "ready" && value.written !== null
                ? "completed"
                : value.kind === "unavailable"
                  ? value.effect
                  : "none",
          };
        },
      });
      return executed.kind === "completed"
        ? executed.value
        : {
            kind: "unavailable",
            reason: executed.receipt.state,
            effect: writing ? "uncertain" : "none",
          };
    },
  };
}

/** Shell host port: current session binding is supplied by the active runtime. */
export type SessionExportControl = (
  argument: string | null,
  signal: AbortSignal,
) => Promise<{ readonly message: string }>;
