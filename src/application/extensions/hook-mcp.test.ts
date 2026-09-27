import { expect, test } from "bun:test";
import { hookFixtureEnvelope, mcpHookDeclaration } from "../../domain/extensions/hook-fixtures.ts";
import { mcpHookContract } from "../../domain/extensions/hook-mcp.ts";
import { hookDecisionBinding } from "../../domain/extensions/hook-protocol.ts";
import type { HookHandlerFacts } from "../../domain/tools/hook-evidence.ts";
import type {
  HookCapabilityRequest,
  HookCapabilityResult,
  ToolHookContext,
} from "../../domain/tools/tool-hooks.ts";
import { HookExecutionError } from "../tools/tool-hook-invocation.ts";
import { createHookMcp, type HookMcpSession } from "./hook-mcp.ts";
import type { McpCatalogListing } from "./mcp-catalog.ts";

const DIGEST = "c".repeat(64);
const ENTRY = "mcp:decisions/tool/allow";
const registration = mcpHookContract(mcpHookDeclaration("allow", DIGEST));
const envelope = hookFixtureEnvelope();
const wire = {
  version: 1 as const,
  invocationId: "subject:1:pre",
  contribution: { packageId: "fixture", contributionId: "contribution", generation: 7 },
  envelope,
};

function session(state: { availability: "available" | "stale"; generation: number }) {
  const value: HookMcpSession = {
    catalog: {
      page: () => ({
        kind: "completed",
        value: {
          catalogs: [],
          nextCursor: null,
          entries: [
            {
              id: ENTRY,
              serverId: "decisions",
              kind: "tool",
              name: "allow",
              title: null,
              description: null,
              descriptionTruncated: false,
              inputSchema: null,
              schemaDigest: DIGEST,
              annotations: null,
              catalogGeneration: state.generation,
              availability: state.availability,
              readHandle: null,
              detail: "complete",
            } satisfies McpCatalogListing,
          ],
        },
      }),
    },
    lifecycle: {
      inspect: () =>
        [{ serverId: "decisions", configurationGeneration: 3 }] as unknown as ReturnType<
          HookMcpSession["lifecycle"]["inspect"]
        >,
    },
  };
  return value;
}

/** A result the gateway would hand back for one completed call. */
const completed = (
  structuredContent: unknown,
  overrides: Record<string, unknown> = {},
): HookCapabilityResult => ({
  outcome: { status: "completed", output: {}, effect: "completed" },
  output: {
    result: {
      entryId: ENTRY,
      catalogGeneration: 4,
      schemaDigest: DIGEST,
      isError: false,
      content: [{ type: "text", text: "untrusted" }],
      structuredContent,
      inputRounds: [],
      ...overrides,
    },
  },
});

async function run(options: {
  readonly state?: { availability: "available" | "stale"; generation: number };
  readonly answer?: (request: HookCapabilityRequest) => Promise<HookCapabilityResult>;
  readonly current?: () => Promise<boolean>;
  readonly gateway?: false;
  readonly signal?: AbortSignal;
}) {
  const state = options.state ?? { availability: "available", generation: 4 };
  const requests: HookCapabilityRequest[] = [];
  const facts: HookHandlerFacts[] = [];
  const context: ToolHookContext = {
    signal: options.signal ?? new AbortController().signal,
    expiresAt: Date.now() + 10_000,
    resourceTaskId: "task",
    report: (value) => facts.push(value),
    ...(options.gateway === false
      ? {}
      : {
          invokeCapability: async (request: HookCapabilityRequest) => {
            requests.push(request);
            if (request.toolName === "mcp_connect") {
              state.availability = "available";
              return {
                outcome: { status: "completed", output: {}, effect: "completed" },
                output: {},
              };
            }
            return (options.answer ?? (async () => completed({ decision: { kind: "observe" } })))(
              request,
            );
          },
        }),
  };
  let failure: string | null = null;
  let decision: unknown = null;
  try {
    decision = await createHookMcp(session(state)).run({
      registration,
      wire,
      context,
      current: options.current ?? (async () => true),
    });
  } catch (error) {
    failure = error instanceof HookExecutionError ? error.code : String(error);
  }
  return { decision, failure, requests, facts };
}

test("one gateway call maps the declared fields and returns only the declared decision", async () => {
  const { decision, failure, requests, facts } = await run({});
  expect(failure).toBeNull();
  expect(decision).toEqual({ kind: "observe" });
  expect(requests.map((request) => request.toolName)).toEqual(["mcp_call_tool"]);
  expect(requests[0]?.input).toEqual({
    entryId: ENTRY,
    catalogGeneration: 4,
    argumentsJson: JSON.stringify({
      binding: hookDecisionBinding(envelope),
      capability: "builtin:workspace/read_file@1",
    }),
  });
  expect(facts).toEqual([
    expect.objectContaining({
      transport: "mcp",
      status: "completed",
      schemaGeneration: 4,
      response: "valid",
      effects: "unknown",
    }),
  ]);
});

test("an unconnected server is connected through the gateway before the one call", async () => {
  const { failure, requests } = await run({ state: { availability: "stale", generation: 4 } });
  expect(failure).toBeNull();
  expect(requests.map((request) => [request.toolName, request.input])).toEqual([
    ["mcp_connect", { serverId: "decisions", configurationGeneration: 3 }],
    ["mcp_call_tool", expect.objectContaining({ entryId: ENTRY })],
  ]);
});

test("a stale activation never dispatches the call", async () => {
  const { failure, requests } = await run({ current: async () => false });
  expect(failure).toBe("hook-authority-stale");
  expect(requests).toEqual([]);
});

test("a catalog that changed while the call ran cannot authorize, even with a decision", async () => {
  const { failure, facts } = await run({
    answer: async () => completed({ decision: { kind: "observe" } }, { catalogGeneration: 5 }),
  });
  expect(failure).toBe("hook-mcp-schema-changed");
  expect(facts[0]).toMatchObject({ response: "stale", effects: "unknown" });
});

test("shutdown during the call cancels without a decision and keeps the effect unknown", async () => {
  const controller = new AbortController();
  const { failure, facts } = await run({
    signal: controller.signal,
    answer: async () => {
      controller.abort();
      return { outcome: { status: "cancelled", effect: "uncertain" }, output: null };
    },
  });
  expect(failure).toBe("cancelled");
  expect(facts[0]).toMatchObject({ status: "cancelled", effects: "unknown" });
});

test("hook-origin recursion is refused, and nothing runs outside a gateway", async () => {
  const recursive = await run({
    answer: async () => ({
      outcome: { status: "denied", reason: "hook-recursion-denied", effect: "none" },
      output: null,
    }),
  });
  expect(recursive.failure).toBe("hook-recursion-denied");
  expect(recursive.facts[0]).toMatchObject({ status: "not-started", effects: "none" });
  const outside = await run({ gateway: false });
  expect(outside.failure).toBe("hook-mcp-gateway-unavailable");
});
