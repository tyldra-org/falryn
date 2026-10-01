import { describe, expect, test } from "bun:test";
import { sampleRegistry } from "./command.fixtures.ts";
import {
  argumentHint,
  commandReference,
  commandUsage,
  formatCommandReference,
} from "./command-reference.ts";

const registry = sampleRegistry();

describe("command reference", () => {
  test("usage shows the canonical argument and each alias as typed", () => {
    const mode = registry.entry("mode.select");
    const profile = registry.entry("profile.inspect");
    const load = registry.entry("workspace.load");
    const advisor = registry.entry("advisor.consult");
    if (!mode || !profile || !load || !advisor) throw new Error("fixture missing");
    expect(commandUsage(mode)).toEqual(["/mode [ask|plan]", "/ask", "/plan"]);
    expect(commandUsage(profile)).toEqual([
      "/profile [list|use <profile id>|apply <candidate id>|preview [profile id]]",
    ]);
    expect(commandUsage(load)).toEqual(["/workspace load [layout name]", "/load-workspace"]);
    expect(argumentHint(advisor.argument)).toBe("<focus>");
  });

  test("projects every entry with its generation, timings and binding", () => {
    const reference = commandReference(registry, (entry) => (entry.id === "app.help" ? "?" : null));
    expect(reference.schemaVersion).toBe(1);
    expect(reference.generation).toBe(registry.generation);
    expect(reference.commands.map((command) => command.id)).toEqual(
      registry.entries.map((entry) => entry.id),
    );
    expect(reference.commands[0]).toMatchObject({ id: "app.help", binding: "?" });
    expect(reference.commands.find((command) => command.id === "mode.select")).toMatchObject({
      timing: "immediate",
      argumentTimings: ["safe-point"],
    });
    expect(
      reference.commands.find((command) => command.id === "app.help")?.argumentTimings,
    ).toEqual([]);
    // JSON round-trips without loss: no functions or renderer values leak in.
    expect(JSON.parse(JSON.stringify(reference))).toEqual(reference);
  });

  test("plain text names usage, facts and the owner of a planned entry", () => {
    const lines = formatCommandReference(
      commandReference(registry, (entry) => (entry.id === "app.help" ? "?" : null)),
    );
    expect(lines[0]).toBe(
      `Falryn shell commands (registry ${registry.generation}, ${registry.entries.length} entries)`,
    );
    const text = lines.join("\n");
    expect(text).toContain(
      "Help (app.help)\n  /help\n  Show every command and its key.\n  key ? · timing immediate · effect interactive",
    );
    expect(text).toContain("  /mode [ask|plan]; also /ask, /plan");
    expect(text).toContain("timing immediate, safe-point with an argument · effect mutation");
    expect(text).toContain("  Not available yet: the advisor action is not wired yet (#1216)");
  });
});
