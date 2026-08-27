import { describe, expect, test } from "bun:test";
import {
  EXECUTION_PROFILE_IDS,
  EXECUTION_PROFILES,
  executionProfile,
  resolveExecutionProfile,
} from "./execution-profile.ts";
import { configurationGeneration } from "./identity.ts";

describe("execution profiles", () => {
  test("define one exhaustive stable preset for every public profile", () => {
    expect(EXECUTION_PROFILES.map((profile) => profile.id)).toEqual([...EXECUTION_PROFILE_IDS]);
    expect(new Set(EXECUTION_PROFILES.map((profile) => profile.completion)).size).toBe(4);
    expect(EXECUTION_PROFILES.every((profile) => profile.schemaVersion === 1)).toBe(true);
  });

  test("Ask and Plan deny every consequential effect", () => {
    for (const id of ["ask", "plan"] as const) {
      const resolved = resolveExecutionProfile(id, configurationGeneration.from(7));
      expect(resolved.allowedEffects).toEqual(["observation"]);
      expect(resolved.deniedEffects).toEqual(["mutation", "external", "interactive"]);
      expect(resolved.configurationGeneration).toBe(configurationGeneration.from(7));
    }
  });

  test("Debug permits probes but denies direct fixing operations", () => {
    const debug = resolveExecutionProfile("debug", configurationGeneration.from(3));
    expect(debug.allowedEffects).toEqual(["observation", "mutation", "external", "interactive"]);
    expect(debug.deniedToolNames).toContain("apply_patch");
    expect(debug.deniedToolNames).toContain("lsp_rename");
    expect(debug.deniedToolNames).not.toContain("run_process");
    expect(debug.deniedToolNames).not.toContain("dap_stack_trace");
  });

  test("Agent preserves the full authorized loop", () => {
    const agent = executionProfile("agent");
    expect(agent.deniedToolNames).toEqual([]);
    expect(agent.completion).toBe("implemented-and-verified");
  });
});
