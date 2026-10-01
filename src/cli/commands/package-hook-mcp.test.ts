import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIGURATION_FILE_NAME } from "../../config/index.ts";
import { removeTemporaryRoots, temporaryRoot } from "../../data/fixtures.ts";
import { mcpHookDeclaration } from "../../domain/extensions/hook-fixtures.ts";
import { normalizeMcpToolSchema } from "../../domain/extensions/mcp-catalog.ts";
import { MCP_HOOK_FIXTURE_INPUT } from "../../integrations/extensions/mcp-fixtures.ts";
import { createHostSandbox } from "../../integrations/security/host-sandbox.ts";
import { nativeProductJourney, observerNotices } from "../runtime/native-product-fixtures.ts";
import { prepareNativeCliFixture } from "./package-native-fixtures.ts";

afterEach(removeTemporaryRoots);
const unavailable =
  process.platform === "win32" || createHostSandbox().probe().status !== "available";
const SERVER = fileURLToPath(
  new URL("../../integrations/extensions/mcp-fixtures.ts", import.meta.url),
);
const DIGEST = normalizeMcpToolSchema(MCP_HOOK_FIXTURE_INPUT)?.digest ?? "";

type Journey = Awaited<ReturnType<typeof nativeProductJourney>>;
const recorded = (journey: Journey) =>
  journey.events?.ok
    ? journey.events.value.flatMap((event) =>
        event.kind === "history.recorded" ? [event.payload as Record<string, unknown>] : [],
      )
    : [];
const proposals = (journey: Journey, name: string) =>
  recorded(journey).filter((entry) => entry.type === "proposal" && entry.name === name);
const hookGates = (journey: Journey) =>
  recorded(journey).filter((entry) => entry.type === "gate" && entry.hook);
const answered = (journey: Journey) =>
  journey.requests.filter((request) => request.includes('\\"answer\\":42'));

/** One headless run whose native tool is gated by an MCP hook on the configured server. */
async function journey(
  toolId: string,
  options: {
    readonly digest?: string;
    readonly mode?: string;
    readonly confirm?: boolean;
    /** Declare an async after-invocation observer instead of a gate. */
    readonly observe?: boolean;
  } = {},
) {
  const root = await temporaryRoot("falryn-hook-mcp-");
  const fixture = await prepareNativeCliFixture("in-process", root, {
    declarations: [
      mcpHookDeclaration(
        toolId,
        options.digest ?? DIGEST,
        options.observe ? { point: "after-capability-invocation", mode: "async" } : {},
      ),
    ],
    files: {},
  });
  await writeFile(
    join(root, "config", CONFIGURATION_FILE_NAME),
    JSON.stringify({
      schemaVersion: 1,
      tools: {
        sandbox: { version: 1, mode: "strict", readRoots: [dirname(SERVER)], writeRoots: [] },
        mcpConnections: {
          servers: [
            {
              id: "decisions",
              transport: "stdio",
              executable: process.execPath,
              args: [SERVER, options.mode ?? "hooks"],
            },
          ],
        },
      },
    }),
  );
  const confirmations: string[] = [];
  const result = await nativeProductJourney(
    { home: root, environment: fixture.environment, name: fixture.name },
    {
      toolConfirmation: {
        async resolve(request) {
          confirmations.push(String(request.capabilityId));
          return options.confirm === false
            ? { kind: "refused" }
            : { kind: "confirmed", confirmationId: request.confirmationId };
        },
      },
    },
  );
  return { journey: result, confirmations };
}

test.skipIf(unavailable).each([
  ["allow", false],
  ["veto", true],
] as const)(
  "an installed MCP tool hook gates a real native tool through the session's MCP gateway: %s",
  async (tool, veto) => {
    const { journey: run, confirmations } = await journey(tool);
    // The hook's own connect and call went through ordinary confirmation, once each.
    expect(proposals(run, "mcp_connect")).toHaveLength(1);
    expect(proposals(run, "mcp_call_tool")).toHaveLength(1);
    expect(confirmations.filter((id) => id.includes("mcp_call_tool"))).toHaveLength(1);
    // Hook-origin work suppresses the same point instead of re-entering it.
    expect(
      recorded(run).filter(
        (entry) => entry.stage === "pre-hook" && entry.decision === "reentry-suppressed",
      ),
    ).toHaveLength(2);
    expect(
      hookGates(run).filter((gate) => gate.decision === (veto ? "veto" : "observe")),
    ).toHaveLength(1);
    expect(run.result.payload?.stage).toBe(veto ? "attempt-failed" : "attempt-completed");
    // The subject ran exactly once on allow, never on veto, and the model saw its result.
    expect(answered(run)).toHaveLength(veto ? 0 : 1);
  },
  90_000,
);
+test.skipIf(unavailable)(
  "an async MCP observer calls its tool through the gateway after the subject settles and leaves one notice",
  async () => {
    const { journey: run } = await journey("allow", { observe: true });
    expect(run.result.payload?.stage).toBe("attempt-completed");
    expect(answered(run)).toHaveLength(1);
    // The observer's connect and call are ordinary hook-origin work, once each.
    expect(proposals(run, "mcp_connect")).toHaveLength(1);
    expect(proposals(run, "mcp_call_tool")).toHaveLength(1);
    const observer = hookGates(run).filter((gate) => gate.stage === "post-hook");
    expect(observer.map((gate) => gate.decision)).toEqual([
      "hook-chain-bound",
      "queued",
      "observe",
    ]);
    // Its own work suppressed the point that asked rather than queueing it again.
    expect(
      recorded(run).filter(
        (entry) => entry.stage === "post-hook" && entry.decision === "reentry-suppressed",
      ),
    ).toHaveLength(2);
    expect(observerNotices(run)).toHaveLength(1);
  },
  90_000,
);

test.skipIf(unavailable).each([
  // [name, tool, options, failure, calls, receipt facts]
  [
    "a prose-only answer",
    "text",
    {},
    "hook-mcp-output-missing",
    1,
    { status: "completed", response: "missing", effects: "unknown" },
  ],
  [
    "an isError result",
    "refuse",
    {},
    "hook-mcp-tool-error",
    1,
    { status: "completed", response: "invalid", effects: "unknown" },
  ],
  [
    "a different input schema",
    "allow",
    { digest: "b".repeat(64) },
    "hook-mcp-schema-changed",
    0,
    { status: "not-started", response: "missing", effects: "none" },
  ],
  [
    "a refused confirmation",
    "allow",
    { confirm: false },
    "hook-mcp-call-refused",
    0,
    { status: "not-started", response: "refused", effects: "none" },
  ],
  [
    "a server that disconnects after receiving the call",
    "allow",
    { mode: "hooks-disconnect" },
    "hook-mcp-effect-uncertain",
    1,
    { status: "disconnected", effects: "unknown" },
  ],
] as const)(
  "%s cannot authorize: the gate fails closed and the subject never runs",
  async (_name, tool, options, failure, calls, facts) => {
    const { journey: run } = await journey(tool, options);
    expect(run.result.payload?.stage).toBe("attempt-failed");
    expect(answered(run)).toEqual([]);
    expect(proposals(run, "mcp_call_tool")).toHaveLength(calls);
    const gate = hookGates(run).find((entry) => entry.decision === `failed:${failure}`);
    // Receipts carry remote transport facts and the size of a result, never its content.
    const hook = gate?.hook as { failureEvidence?: { handlerFacts?: unknown } } | undefined;
    expect(hook?.failureEvidence?.handlerFacts).toMatchObject({
      kind: "remote",
      transport: "mcp",
      ...facts,
    });
  },
  90_000,
);
