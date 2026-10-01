import { describe, expect, test } from "bun:test";
import { commandSpec, sampleRegistry } from "./command.fixtures.ts";
import { admitCommand } from "./command-admission.ts";

const registry = sampleRegistry();

describe("command admission", () => {
  test("a planned entry is refused with its owner, whatever the caller", () => {
    const advisor = registry.entry("advisor.consult");
    if (advisor === undefined) throw new Error("fixture missing");
    expect(
      admitCommand(advisor, { caller: "interactive", timing: "immediate", turnActive: false }),
    ).toEqual({
      ok: false,
      code: "command-planned",
      owner: "#1216",
      message: "/advisor is not available yet: the advisor action is not wired yet (#1216).",
    });
  });

  test("a caller the entry does not list is refused, naming the interactive shell for headless", () => {
    const help = registry.entry("app.help");
    if (help === undefined) throw new Error("fixture missing");
    expect(
      admitCommand(help, { caller: "headless", timing: "immediate", turnActive: false }),
    ).toEqual({
      ok: false,
      code: "caller-unsupported",
      caller: "headless",
      message: "/help needs the interactive shell; run falryn without a subcommand to use it.",
    });
    expect(
      admitCommand(help, { caller: "model", timing: "immediate", turnActive: false }),
    ).toMatchObject({ ok: false, code: "caller-unsupported", caller: "model" });
  });

  test("immediate invocations run during a turn", () => {
    const help = registry.entry("app.help");
    if (help === undefined) throw new Error("fixture missing");
    expect(
      admitCommand(help, { caller: "interactive", timing: "immediate", turnActive: true }),
    ).toEqual({
      ok: true,
    });
  });

  test("safe-point and queued invocations are refused during a turn and run after it", () => {
    const mode = registry.entry("mode.select");
    if (mode === undefined) throw new Error("fixture missing");
    expect(
      admitCommand(mode, { caller: "interactive", timing: "safe-point", turnActive: true }),
    ).toEqual({
      ok: false,
      code: "unavailable-while-turn-active",
      timing: "safe-point",
      message: "/mode changes state the running turn uses; run it again after the turn finishes.",
    });
    const goal = commandSpec({ id: "goal.start", slash: [{ form: "/goal" }], timing: "queued" });
    expect(
      admitCommand(goal, { caller: "interactive", timing: "queued", turnActive: true }),
    ).toEqual({
      ok: false,
      code: "unavailable-while-turn-active",
      timing: "queued",
      message: "/goal starts work; run it again after the turn finishes.",
    });
    expect(
      admitCommand(mode, { caller: "interactive", timing: "safe-point", turnActive: false }),
    ).toEqual({ ok: true });
  });
});
