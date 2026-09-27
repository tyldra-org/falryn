/**
 * The package MCP tool hook adapter (#1174). It owns no transport: the configured server's
 * tool is reached only through the enclosing gateway's hook-origin admission, the same
 * path as a model's mcp_call_tool with its policy, confirmation, resources and receipts.
 *
 * One call per invocation, never retried. The decision comes only from the declared field
 * of the structured result; isError, a missing field, a changed schema or catalog, an
 * uncertain effect or a stale activation all fail the hook, which then settles by the
 * point's own posture.
 */

import {
  type McpHookRegistration,
  mcpHookArguments,
  mcpHookDecisionCandidate,
} from "../../domain/extensions/hook-mcp.ts";
import { HOOK_LIMITS } from "../../domain/extensions/hook-points.ts";
import {
  type HookDecision,
  type HookWireInput,
  validateHookDecision,
} from "../../domain/extensions/hook-protocol.ts";
import { mcpEntryId } from "../../domain/extensions/mcp-catalog.ts";
import type { HookHandlerFacts } from "../../domain/tools/hook-evidence.ts";
import type { ToolHookContext } from "../../domain/tools/tool-hooks.ts";
import { HookExecutionError } from "../tools/tool-hook-invocation.ts";
import type { McpCatalog, McpToolResult } from "./mcp-catalog.ts";
import type { McpLifecycle } from "./mcp-lifecycle.ts";

/** The session's MCP runtime, as far as a hook may see it: read-only catalog state. */
export type HookMcpSession = {
  readonly catalog: Pick<McpCatalog, "page">;
  readonly lifecycle: Pick<McpLifecycle, "inspect">;
};
export type HookMcpPort = {
  run(input: {
    registration: McpHookRegistration;
    wire: HookWireInput;
    context: ToolHookContext;
    current(): Promise<boolean>;
  }): Promise<HookDecision>;
};

type Remote = Extract<HookHandlerFacts, { kind: "remote" }>;

export function createHookMcp(session: HookMcpSession): HookMcpPort {
  return {
    async run({ registration, wire, context, current }) {
      const { serverId, toolId, schemaDigest, outputField } = registration.handler;
      const facts: Remote = {
        kind: "remote",
        transport: "mcp",
        status: "not-started",
        httpStatus: null,
        schemaGeneration: null,
        response: "missing",
        omittedBytes: 0,
        effects: "none",
      };
      const signal = context.signal;
      const stopped = () =>
        new HookExecutionError(Date.now() >= context.expiresAt ? "timed-out" : "cancelled");
      const invoke = context.invokeCapability;
      try {
        if (signal.aborted) throw stopped();
        if (invoke === undefined) throw new HookExecutionError("hook-mcp-gateway-unavailable");
        const entryId = mcpEntryId(serverId, "tool", toolId);
        const resolve = () => {
          const page = session.catalog.page({ entryId });
          const entry = page.kind === "completed" ? page.value.entries[0] : undefined;
          return entry?.kind === "tool" ? entry : undefined;
        };
        let entry = resolve();
        if (entry?.availability !== "available") {
          // An unconnected or stale server is connected the ordinary way, with the user's
          // approval, so a gate hook cannot lock the session out of its own server.
          const connection = session.lifecycle
            .inspect()
            .find((snapshot) => snapshot.serverId === serverId);
          if (connection === undefined) throw new HookExecutionError("hook-mcp-tool-unavailable");
          const connected = await invoke({
            toolName: "mcp_connect",
            input: { serverId, configurationGeneration: connection.configurationGeneration },
            signal,
          });
          if (signal.aborted) throw stopped();
          if (connected.outcome.status !== "completed") {
            facts.response = "refused";
            throw new HookExecutionError(refusal(connected.outcome));
          }
          entry = resolve();
        }
        if (entry?.availability !== "available")
          throw new HookExecutionError("hook-mcp-tool-unavailable");
        // The mapping was written against one schema; any other schema is a different tool.
        if (entry.schemaDigest !== schemaDigest)
          throw new HookExecutionError("hook-mcp-schema-changed");
        facts.schemaGeneration = entry.catalogGeneration;
        const values = mcpHookArguments(registration, wire.envelope);
        const argumentsJson = JSON.stringify(values);
        if (Buffer.byteLength(argumentsJson) > HOOK_LIMITS.inputBytes)
          throw new HookExecutionError("hook-input-too-large");
        if (!(await current()) || signal.aborted)
          throw signal.aborted ? stopped() : new HookExecutionError("hook-authority-stale");
        const called = await invoke({
          toolName: "mcp_call_tool",
          input: { entryId, catalogGeneration: entry.catalogGeneration, argumentsJson },
          signal,
        });
        const outcome = called.outcome;
        // Anything other than a clean refusal may have reached the server.
        facts.effects = outcome.effect === "none" ? "none" : "unknown";
        if (outcome.status === "cancelled" || outcome.status === "timed-out" || signal.aborted) {
          facts.status = outcome.status === "timed-out" ? "timed-out" : "cancelled";
          throw stopped();
        }
        if (outcome.status !== "completed") {
          facts.status = outcome.effect === "none" ? "not-started" : "disconnected";
          if (outcome.effect === "none") facts.response = "refused";
          throw new HookExecutionError(
            outcome.effect === "none" ? refusal(outcome) : "hook-mcp-effect-uncertain",
          );
        }
        facts.status = "completed";
        const result = called.output?.result as McpToolResult | undefined;
        if (result === undefined) throw new HookExecutionError("invalid-hook-response");
        // The body is never retained; only its size and decoded decision leave this owner.
        facts.omittedBytes = Buffer.byteLength(JSON.stringify(result));
        if (
          result.catalogGeneration !== entry.catalogGeneration ||
          result.schemaDigest !== schemaDigest
        ) {
          facts.response = "stale";
          throw new HookExecutionError("hook-mcp-schema-changed");
        }
        if (result.isError) {
          facts.response = "invalid";
          throw new HookExecutionError("hook-mcp-tool-error");
        }
        const candidate = mcpHookDecisionCandidate(result.structuredContent, outputField);
        if (candidate === undefined) throw new HookExecutionError("hook-mcp-output-missing");
        if (!(await current()) || signal.aborted)
          throw signal.aborted ? stopped() : new HookExecutionError("hook-authority-stale");
        try {
          const decision = validateHookDecision(registration, wire.envelope, candidate);
          facts.response = "valid";
          return decision;
        } catch {
          facts.response = "invalid";
          throw new HookExecutionError("invalid-hook-response");
        }
      } finally {
        context.report?.(facts);
      }
    },
  };
}

function refusal(outcome: { readonly status: string; readonly reason?: string }): string {
  return outcome.reason === "hook-recursion-denied"
    ? "hook-recursion-denied"
    : "hook-mcp-call-refused";
}
