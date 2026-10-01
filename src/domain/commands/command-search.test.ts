import { describe, expect, test } from "bun:test";
import { commandSpec, sampleRegistry } from "./command.fixtures.ts";
import { createCommandRegistry } from "./command-registry.ts";
import { COMMAND_MATCH_TIERS, matchTier, searchCommands } from "./command-search.ts";

const registry = sampleRegistry();
const ids = (query: string, limit?: number) =>
  searchCommands(registry, query, limit === undefined ? {} : { limit }).map((entry) => entry.id);

describe("command search", () => {
  test("an empty query lists entries in registry order, bounded by the limit", () => {
    expect(ids("")).toEqual(registry.entries.map((entry) => entry.id));
    expect(ids("   ", 2)).toEqual(["app.help", "mode.select"]);
  });

  test("ranks exact, slash-prefix, name-prefix, word-prefix, substring then fuzzy", () => {
    const help = registry.entry("app.help");
    const mode = registry.entry("mode.select");
    const routes = registry.entry("model.routes");
    if (help === undefined || mode === undefined || routes === undefined)
      throw new Error("fixture");
    expect(matchTier(help, "/help")).toBe(COMMAND_MATCH_TIERS.exact);
    expect(matchTier(help, "app.help")).toBe(COMMAND_MATCH_TIERS.exact);
    expect(matchTier(help, "he")).toBe(COMMAND_MATCH_TIERS.slashPrefix);
    expect(matchTier(mode, "select")).toBe(COMMAND_MATCH_TIERS.namePrefix);
    expect(matchTier(help, "shortcut")).toBe(COMMAND_MATCH_TIERS.wordPrefix);
    expect(matchTier(routes, "odel rou")).toBe(COMMAND_MATCH_TIERS.substring);
    expect(matchTier(mode, "mdsl")).toBe(COMMAND_MATCH_TIERS.fuzzy);
    expect(matchTier(help, "zzz")).toBeNull();
  });

  test("orders by tier and keeps registry order within a tier", () => {
    // `/model` is exact for model.settings; `/model routes` is a prefix match.
    expect(ids("/model")).toEqual(["model.settings", "model.routes"]);
    expect(ids("workspace")).toEqual(["workspace.load", "workspace.show"]);
  });

  test("a leading slash searches slash forms only", () => {
    expect(ids("/select")).toEqual([]);
    expect(ids("select")).toEqual(["mode.select"]);
  });

  test("the include filter narrows candidates before ranking", () => {
    expect(
      searchCommands(registry, "", { include: (entry) => entry.status.kind === "planned" }).map(
        (entry) => entry.id,
      ),
    ).toEqual(["advisor.consult"]);
  });

  test("is deterministic for equal input and bounds the query", () => {
    expect(ids("o")).toEqual(ids("o"));
    const long = `${"a".repeat(500)}`;
    expect(ids(long)).toEqual([]);
    const built = createCommandRegistry([
      commandSpec({ id: "app.alpha", title: "Alpha" }),
      commandSpec({ id: "app.beta", title: "Beta" }),
    ]);
    if (!built.ok) throw new Error("expected a valid registry");
    expect(searchCommands(built.value, "app", { limit: 1 }).map((entry) => entry.id)).toEqual([
      "app.alpha",
    ]);
  });
});
