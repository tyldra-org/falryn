import { describe, expect, test } from "bun:test";

import { commandSpec } from "../../domain/commands/command.fixtures.ts";
import { createCommandRegistry } from "../../domain/commands/index.ts";
import { configurationGeneration } from "../../domain/foundation/index.ts";
import {
  type CommandActionDispatcher,
  type CommandActionHandler,
  createCommandActionDispatcher,
} from "../commands/index.ts";
import type { ToolRunnerRequest } from "../runtime/tool-call-loop.ts";
import { COMMAND_ACTION_TOOL_NAME, composeCommandActionTool } from "./command-action-tool.ts";

const MODEL = ["interactive", "headless", "model"] as const;

function dispatcherWith(handle: CommandActionHandler): CommandActionDispatcher {
  const registry = createCommandRegistry([
    commandSpec({
      id: "probe.read",
      slash: [{ form: "/probe" }],
      effect: "observation",
      callers: MODEL,
    }),
    commandSpec({
      id: "probe.write",
      slash: [{ form: "/probe-write" }],
      argument: { kind: "text", hint: "value", maxBytes: 64, required: true },
      effect: "mutation",
      callers: MODEL,
    }),
    commandSpec({
      id: "probe.switch",
      slash: [{ form: "/probe-switch" }],
      timing: "safe-point",
      effect: "mutation",
      callers: MODEL,
    }),
    commandSpec({ id: "probe.panel", slash: [{ form: "/probe-panel" }], effect: "mutation" }),
  ]);
  if (!registry.ok) throw new Error("fixture registry");
  return createCommandActionDispatcher(registry.value, {
    "probe.read": handle,
    "probe.write": handle,
    "probe.switch": handle,
  });
}

function tool(dispatcher: CommandActionDispatcher | null) {
  const bundle = composeCommandActionTool(configurationGeneration.from(2), () => dispatcher);
  const entry = bundle.registry.resolveByName(COMMAND_ACTION_TOOL_NAME);
  if (entry === null) throw new Error("tool missing");
  const run = (input: Readonly<Record<string, unknown>>, signal = new AbortController().signal) =>
    bundle.runner.execute({
      toolName: COMMAND_ACTION_TOOL_NAME,
      capabilityId: entry.manifest.capabilityId,
      input,
      signal,
    } as unknown as ToolRunnerRequest);
  return { entry, run };
}

describe("command action tool", () => {
  test("classifies a call by the action it would actually run", () => {
    const { entry } = tool(dispatcherWith(async () => ({ kind: "completed", lines: [] })));
    const effectFor = entry.manifest.effectFor;
    if (effectFor === undefined) throw new Error("effectFor missing");
    expect(entry.manifest.effect).toBe("observation");
    expect(effectFor({ operation: "list" })).toBe("observation");
    expect(effectFor({ operation: "invoke", slash: "/probe" })).toBe("observation");
    // An admitted change carries its declared effect into gateway policy and confirmation.
    expect(effectFor({ operation: "invoke", action: "probe.write", argument: "x" })).toBe(
      "mutation",
    );
    // A request the dispatcher would refuse runs nothing, so it needs no confirmation.
    expect(effectFor({ operation: "invoke", slash: "/probe-switch" })).toBe("observation");
    expect(effectFor({ operation: "invoke", slash: "/probe-panel" })).toBe("observation");
    expect(effectFor({ operation: "invoke", slash: "/nothing" })).toBe("observation");
  });

  test("maps outcomes to tool results without hiding a refusal or a failure", async () => {
    let fail = false;
    const { run } = tool(
      dispatcherWith(async (invocation) => {
        if (fail) throw new Error("store offline");
        return { kind: "completed", lines: [`ran ${invocation.commandId}`] };
      }),
    );
    const listed = await run({ operation: "list", query: "probe" });
    expect(listed).toMatchObject({ status: "completed", output: { status: "listed" } });
    expect(
      (listed as unknown as { output: { actions: { id: string }[] } }).output.actions.map(
        (card) => card.id,
      ),
    ).toEqual(["probe.read", "probe.write", "probe.switch"]);

    expect(await run({ operation: "invoke", action: "probe.read" })).toMatchObject({
      status: "completed",
      output: {
        status: "completed",
        action: "probe.read",
        form: "/probe",
        lines: ["ran probe.read"],
      },
    });
    expect(await run({ operation: "invoke", slash: "/probe-panel" })).toMatchObject({
      status: "completed",
      output: { status: "refused", code: "interactive-only", action: "probe.panel" },
    });
    expect(await run({ operation: "invoke", action: "probe.read", slash: "/probe" })).toMatchObject(
      { status: "completed", output: { status: "refused", code: "invalid-request" } },
    );
    expect(await run({ operation: "invoke" })).toMatchObject({
      output: { status: "refused", code: "invalid-request" },
    });
    fail = true;
    expect(await run({ operation: "invoke", slash: "/probe" })).toEqual({
      status: "failed",
      reason: "store offline",
      effect: "none",
    });
    expect(await run({ operation: "invoke", action: "probe.write", argument: "x" })).toEqual({
      status: "failed",
      reason: "store offline",
      effect: "uncertain",
    });
    const aborted = new AbortController();
    aborted.abort();
    expect(await run({ operation: "invoke", slash: "/probe" }, aborted.signal)).toEqual({
      status: "cancelled",
      effect: "none",
    });
  });

  test("reports a session without action owners as unavailable", async () => {
    expect(await tool(null).run({ operation: "list" })).toEqual({
      status: "unavailable",
      reason: "command-actions-unavailable",
      effect: "none",
    });
  });
});
