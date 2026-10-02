import { describe, expect, test } from "bun:test";

import { commandSpec } from "../../domain/commands/command.fixtures.ts";
import {
  type CommandCaller,
  type CommandSpec,
  createCommandRegistry,
  planned,
} from "../../domain/commands/index.ts";
import {
  type CommandActionInvocation,
  type CommandActionTarget,
  createCommandActionDispatcher,
} from "./index.ts";

const ALL: readonly CommandCaller[] = ["interactive", "headless", "model"];

const SPECS: readonly CommandSpec[] = [
  commandSpec({
    id: "probe.list",
    title: "List probes",
    description: "List probes, optionally filtered.",
    keywords: ["probes"],
    slash: [{ form: "/probes" }, { form: "/pr" }],
    argument: { kind: "text", hint: "filter", maxBytes: 32, required: false },
    effect: "observation",
    callers: ALL,
  }),
  commandSpec({
    id: "probe.mode",
    title: "Probe mode",
    description: "Report or change the probe mode.",
    slash: [{ form: "/probe-mode" }, { form: "/quick", fixedArgument: "quick" }],
    argument: {
      kind: "options",
      hint: "mode",
      options: [
        { value: "quick", operand: null, timing: "safe-point" },
        { value: "slow", operand: null, timing: "safe-point" },
      ],
    },
    effect: "mutation",
    callers: ALL,
  }),
  commandSpec({
    id: "probe.panel",
    title: "Probe panel",
    description: "Open the probe panel.",
    slash: [{ form: "/probe-panel" }],
    effect: "interactive",
  }),
  commandSpec({
    id: "probe.later",
    title: "Later probe",
    description: "Not delivered yet.",
    slash: [{ form: "/later" }],
    effect: "observation",
    callers: ALL,
    status: planned("#9999", "its owner has not delivered it"),
  }),
];

function setup(handle?: (invocation: CommandActionInvocation, signal: AbortSignal) => unknown) {
  const registry = createCommandRegistry(SPECS);
  if (!registry.ok) throw new Error("fixture registry");
  const calls: CommandActionInvocation[] = [];
  const respond = async (invocation: CommandActionInvocation, signal: AbortSignal) => {
    calls.push(invocation);
    const handled = await handle?.(invocation, signal);
    return (
      (handled as never) ?? {
        kind: "completed" as const,
        lines: [`${invocation.commandId}:${invocation.argument ?? "-"}`],
      }
    );
  };
  const dispatcher = createCommandActionDispatcher(registry.value, {
    "probe.list": respond,
    "probe.mode": respond,
  });
  const invoke = (
    target: CommandActionTarget,
    caller: CommandCaller = "model",
    options: { readonly signal?: AbortSignal; readonly generation?: string } = {},
  ) =>
    dispatcher.invoke({
      caller,
      target,
      turnActive: caller === "model",
      signal: options.signal ?? new AbortController().signal,
      ...(options.generation === undefined ? {} : { generation: options.generation }),
    });
  return { dispatcher, calls, invoke };
}

describe("command action dispatcher", () => {
  test("canonical, alias and action-ID calls reach the same owner once with one normalized intent", async () => {
    const { calls, invoke } = setup();
    const canonical = await invoke({ kind: "slash", text: "/probes  north" }, "interactive");
    const alias = await invoke({ kind: "slash", text: "/PR north" }, "headless");
    const byId = await invoke({ kind: "action", id: "probe.list", argument: "north" });
    expect(calls).toHaveLength(3);
    const identities = [canonical, alias, byId].map((outcome) => {
      if (outcome.kind !== "completed") throw new Error(outcome.kind);
      expect(outcome.lines).toEqual(["probe.list:north"]);
      const { caller: _caller, form: _form, ...identity } = outcome.invocation;
      return identity;
    });
    expect(identities[1]).toEqual(identities[0]);
    expect(identities[2]).toEqual(identities[0]);
    expect(calls.map((call) => call.caller)).toEqual(["interactive", "headless", "model"]);
    expect(calls.map((call) => call.form)).toEqual(["/probes", "/pr", "/probes"]);
  });

  test("a fixed-argument alias binds the same option as its canonical spelling", async () => {
    const { invoke } = setup();
    const alias = await invoke({ kind: "slash", text: "/quick" }, "interactive");
    const canonical = await invoke(
      { kind: "action", id: "probe.mode", argument: "quick" },
      "interactive",
    );
    expect(alias.kind === "completed" && alias.invocation.argument).toBe("quick");
    expect(canonical.kind === "completed" && canonical.invocation.timing).toBe("safe-point");
  });

  test("refuses unknown, malformed and stale requests without running anything", async () => {
    const { calls, invoke, dispatcher } = setup();
    expect(await invoke({ kind: "action", id: "probe.missing", argument: null })).toMatchObject({
      kind: "refused",
      code: "unknown-action",
    });
    expect(await invoke({ kind: "slash", text: "/nothing here" })).toMatchObject({
      kind: "refused",
      code: "unknown-action",
    });
    expect(await invoke({ kind: "slash", text: "rm -rf ." })).toMatchObject({
      kind: "refused",
      code: "not-a-command",
    });
    expect(
      await invoke({ kind: "action", id: "probe.list", argument: "x".repeat(64) }),
    ).toMatchObject({ kind: "refused", code: "invalid-argument", commandId: "probe.list" });
    expect(
      await invoke({ kind: "action", id: "probe.mode", argument: "sideways" }, "interactive"),
    ).toMatchObject({ kind: "refused", code: "invalid-argument" });
    expect(
      await invoke({ kind: "slash", text: "/probes" }, "model", { generation: "stale" }),
    ).toMatchObject({ kind: "refused", code: "stale-generation" });
    expect(
      await invoke({ kind: "slash", text: "/probes" }, "model", {
        generation: dispatcher.generation,
      }),
    ).toMatchObject({ kind: "completed" });
    expect(calls).toHaveLength(1);
  });

  test("applies each entry's declared callers, status and timing", async () => {
    const { calls, invoke } = setup();
    expect(await invoke({ kind: "slash", text: "/probe-panel" })).toMatchObject({
      kind: "refused",
      code: "interactive-only",
      commandId: "probe.panel",
    });
    expect(await invoke({ kind: "slash", text: "/later" })).toMatchObject({
      kind: "refused",
      code: "command-planned",
    });
    // A model always calls mid-turn; a safe-point change waits for the turn to end.
    expect(await invoke({ kind: "slash", text: "/quick" })).toMatchObject({
      kind: "refused",
      code: "unavailable-while-turn-active",
    });
    expect(calls).toHaveLength(0);
  });

  test("reports cancellation, an unavailable owner and a failed owner truthfully", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const cancelled = setup();
    expect(
      await cancelled.invoke({ kind: "slash", text: "/probes" }, "model", {
        signal: aborted.signal,
      }),
    ).toMatchObject({ kind: "cancelled", invocation: { commandId: "probe.list" } });
    expect(cancelled.calls).toHaveLength(0);

    const midway = new AbortController();
    const interrupted = setup(() => {
      midway.abort();
      return { kind: "completed", lines: ["late"] };
    });
    expect(
      await interrupted.invoke({ kind: "slash", text: "/probes" }, "model", {
        signal: midway.signal,
      }),
    ).toMatchObject({ kind: "cancelled" });

    const unavailable = setup(() => ({ kind: "unavailable", message: "no probes here" }));
    expect(await unavailable.invoke({ kind: "slash", text: "/probes" })).toMatchObject({
      kind: "unavailable",
      message: "no probes here",
    });

    const failing = setup(() => {
      throw new Error("probe store offline");
    });
    expect(await failing.invoke({ kind: "slash", text: "/probes" })).toMatchObject({
      kind: "failed",
      message: "probe store offline",
    });
  });

  test("two concurrent calls of the same action keep separate identities and run once each", async () => {
    const order: string[] = [];
    const { invoke, calls } = setup(async (invocation) => {
      order.push(`start:${invocation.argument}`);
      await Bun.sleep(invocation.argument === "a" ? 10 : 0);
      order.push(`end:${invocation.argument}`);
      return undefined;
    });
    const [first, second] = await Promise.all([
      invoke({ kind: "slash", text: "/probes a" }),
      invoke({ kind: "slash", text: "/pr b" }),
    ]);
    expect(calls).toHaveLength(2);
    expect(first.kind === "completed" && first.lines).toEqual(["probe.list:a"]);
    expect(second.kind === "completed" && second.lines).toEqual(["probe.list:b"]);
    expect(order).toEqual(["start:a", "start:b", "end:b", "end:a"]);
  });

  test("lists only actions the caller may run, with every spelling, bounded", () => {
    const { dispatcher } = setup();
    expect(dispatcher.cards("model").map((card) => card.id)).toEqual(["probe.list", "probe.mode"]);
    expect(dispatcher.cards("model", "filtered")[0]).toMatchObject({
      id: "probe.list",
      forms: ["/probes", "/pr"],
      argument: { kind: "text", hint: "filter", required: false, maxBytes: 32 },
      effect: "observation",
      source: "builtin",
    });
    expect(dispatcher.cards("model", "probe mode")[1]?.forms).toEqual([
      "/probe-mode",
      "/quick (= quick)",
    ]);
    expect(dispatcher.cards("interactive").map((card) => card.id)).toContain("probe.panel");
    expect(dispatcher.resolve({ kind: "slash", text: "/quick" })?.effect).toBe("mutation");
    expect(dispatcher.resolve({ kind: "slash", text: "/unknown" })).toBeNull();
  });

  test("a declared non-interactive caller without an owner is a registry defect", () => {
    const registry = createCommandRegistry(SPECS);
    if (!registry.ok) throw new Error("fixture registry");
    expect(() => createCommandActionDispatcher(registry.value, {})).toThrow(
      "probe.list declares a non-interactive caller without an owner",
    );
  });

  test("an alias another action already spells is rejected before any dispatcher exists", () => {
    const colliding = createCommandRegistry([
      ...SPECS,
      commandSpec({ id: "probe.other", slash: [{ form: "/pr" }], callers: ALL }),
    ]);
    expect(colliding.ok).toBe(false);
  });
});
