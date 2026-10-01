import { describe, expect, test } from "bun:test";
import { SHELL_REGISTRY } from "../commands/registry.ts";
import { isBuiltinComposerSlash, parseComposerSlash } from "./slash.ts";

function resolved(text: string) {
  const parsed = parseComposerSlash(text);
  if (parsed.kind !== "command") throw new Error(`${text} did not resolve: ${parsed.kind}`);
  return { id: parsed.entry.id, argument: parsed.argument, timing: parsed.timing };
}

function refused(text: string) {
  const parsed = parseComposerSlash(text);
  if (parsed.kind !== "invalid") throw new Error(`${text} was not refused: ${parsed.kind}`);
  return parsed.message;
}

describe("built-in slash catalog (#790)", () => {
  test("every row of the canonical catalog resolves to its action", () => {
    const catalog: readonly (readonly [string, string])[] = [
      ["/help", "app.help"],
      ["/commands", "app.commandPalette"],
      ["/status", "status.show"],
      ["/doctor", "doctor.show"],
      ["/tools", "tools.inspect"],
      ["/resources", "resource.show"],
      ["/permissions", "permissions.show"],
      ["/provider", "provider.manage"],
      ["/login", "provider.manage"],
      ["/quota", "quota.show"],
      ["/route", "model.routes"],
      ["/model", "model.settings"],
      ["/mode", "mode.select"],
      ["/ask", "mode.select"],
      ["/plan", "mode.select"],
      ["/debug", "mode.select"],
      ["/agent", "mode.select"],
      ["/fast", "model.processing.inspect"],
      ["/context", "context.show"],
      ["/savings", "context.show"],
      ["/brief", "brief.set"],
      ["/compact", "compact.preview"],
      ["/session", "session.switch"],
      ["/new", "session.new"],
      ["/resume", "session.resume"],
      ["/fork", "session.fork"],
      ["/rewind", "session.rewind"],
      ["/replay", "session.replay"],
      ["/rename", "session.rename"],
      ["/goal", "goal.control"],
      ["/loop", "loop.control"],
      ["/tasks", "tasks.show"],
      ["/agents", "agents.show"],
      ["/workspace show", "workspace.show"],
      ["/changes", "changes.open"],
      ["/search", "transcript.search"],
      ["/extensions", "extensions.show"],
      ["/mcp", "extensions.show"],
      ["/skills", "skills.list"],
      ["/hooks", "extensions.show"],
      ["/plugins", "extensions.show"],
      ["/checkpoint", "checkpoint.create"],
      ["/undo", "undo.apply"],
      ["/settings", "settings.open"],
      ["/export", "session.export"],
      ["/quit", "app.exit"],
      ["/advisor", "advisor.consult"],
    ];
    for (const [text, id] of catalog)
      expect(`${text} → ${resolved(text).id}`).toBe(`${text} → ${id}`);
  });

  test("every registered form resolves back to its own entry", () => {
    for (const form of SHELL_REGISTRY.forms) {
      expect(`${form.form} → ${resolved(form.form).id}`).toBe(`${form.form} → ${form.entry.id}`);
    }
  });

  test("planned rows name their owning issue and never ship as executable", () => {
    for (const id of ["tools.inspect", "goal.control", "transcript.search", "advisor.consult"]) {
      const entry = SHELL_REGISTRY.entry(id);
      expect(entry?.status.kind).toBe("planned");
      expect(entry?.availability({} as never).kind).toBe("unavailable");
    }
    expect(SHELL_REGISTRY.entry("tools.inspect")?.status).toEqual({
      kind: "planned",
      owner: "#192",
      reason: "the capability inspector is not reachable from the shell yet",
    });
  });

  test("there is no /config-model or ambiguous /clear", () => {
    expect(parseComposerSlash("/config-model")).toEqual({ kind: "unknown", name: "/config-model" });
    expect(parseComposerSlash("/clear")).toEqual({ kind: "unknown", name: "/clear" });
  });
});

describe("parseComposerSlash", () => {
  test("maps /workspace verbs and their doc forms onto palette command ids", () => {
    expect(resolved("/workspace show")).toEqual({
      id: "workspace.show",
      argument: null,
      timing: "immediate",
    });
    expect(resolved("/workspace add")).toMatchObject({ id: "workspace.addRoot", argument: null });
    expect(resolved("/workspace save app")).toMatchObject({
      id: "workspace.save",
      argument: "app",
    });
    expect(resolved("/workspace load app")).toEqual({
      id: "workspace.load",
      argument: "app",
      timing: "safe-point",
    });
    expect(resolved("/add-dir /tmp/extra")).toMatchObject({
      id: "workspace.addRoot",
      argument: "/tmp/extra",
    });
    expect(resolved("/save-workspace app")).toMatchObject({ id: "workspace.save" });
    expect(resolved("/load-workspace app")).toMatchObject({ id: "workspace.load" });
  });

  test("keeps path arguments case-sensitive and unquotes a quoted path", () => {
    expect(resolved("/workspace add /Tmp/Extra").argument).toBe("/Tmp/Extra");
    expect(resolved('/workspace add "/tmp/with space"').argument).toBe("/tmp/with space");
  });

  test("refuses an unknown /workspace verb by naming the real ones", () => {
    expect(refused("/workspace remove")).toBe("/workspace expects add, save, load or show.");
    expect(refused("/workspace")).toBe("/workspace expects add, save, load or show.");
    expect(refused("/workspace show extra")).toBe("/workspace show takes no argument.");
  });

  test("opens one compression control surface without an argument", () => {
    expect(resolved("/compression")).toMatchObject({ id: "compression.show", argument: null });
    expect(refused("/compression off")).toBe("/compression takes no argument.");
  });

  test("maps canonical and direct execution-mode aliases onto one action", () => {
    expect(resolved("/mode plan")).toEqual({
      id: "mode.select",
      argument: "plan",
      timing: "safe-point",
    });
    expect(resolved("/debug")).toMatchObject({ id: "mode.select", argument: "debug" });
    expect(resolved("/mode")).toEqual({ id: "mode.select", argument: null, timing: "immediate" });
    expect(refused("/agent extra")).toBe("/agent takes no argument.");
    expect(refused("/mode fast")).toBe(
      "Unsupported value “fast” for /mode. Use /mode ask|plan|debug|agent.",
    );
  });

  test("names every /model and /fast spelling when one is misspelled", () => {
    expect(refused("/model rout")).toBe(
      "/model takes no argument. Use /model, /model roles, /model configure or /model routes.",
    );
    expect(resolved("/fast on")).toEqual({
      id: "model.processing.fast",
      argument: null,
      timing: "safe-point",
    });
  });

  test("subcommand arguments carry their own timing", () => {
    expect(resolved("/profile use work")).toMatchObject({
      argument: "use work",
      timing: "immediate",
    });
    expect(resolved("/profile apply cand-1").timing).toBe("safe-point");
    expect(resolved("/env reload").timing).toBe("safe-point");
    expect(resolved("/compact apply").timing).toBe("safe-point");
    expect(resolved("/compact inspect cand-1").timing).toBe("immediate");
    expect(resolved("/export write nightly")).toMatchObject({ argument: "write nightly" });
  });

  test("leaves ordinary prompts and unclaimed slash text alone", () => {
    expect(parseComposerSlash("hello")).toEqual({ kind: "not-slash" });
    expect(parseComposerSlash("")).toEqual({ kind: "not-slash" });
    expect(parseComposerSlash("/review a.ts")).toEqual({ kind: "unknown", name: "/review" });
  });
});

describe("isBuiltinComposerSlash", () => {
  test("built-in commands, shipped or planned, own their names ahead of templates and skills", () => {
    for (const text of [
      "/mode",
      " /mode plan",
      "/workspace nope",
      "/schedule {}",
      "/peer",
      "/fast",
      "/skills review",
      "/help",
      "/tools",
      "/goal",
    ])
      expect(isBuiltinComposerSlash(text)).toBe(true);
    for (const text of [
      "/review a.ts",
      "/scheduled",
      "/peers",
      "hello",
      "/kit:mode",
      "/skill:review",
      "/usr/bin/env",
      "https://example.com/help",
    ])
      expect(isBuiltinComposerSlash(text)).toBe(false);
  });
});
