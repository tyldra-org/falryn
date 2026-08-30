import { describe, expect, test } from "bun:test";
import { composeProductBriefControls, composeProductOutputControls } from "../application/index.ts";
import { applyCompressionControl, compressionControlState } from "./compression.ts";

describe("compression controls", () => {
  test("projects one state across Brief, Hush, and Loom", () => {
    const brief = composeProductBriefControls({ initialVerbosity: "compact" });
    const output = composeProductOutputControls({ hush: "raw", loom: "loom" });
    expect(compressionControlState(brief, output)).toEqual({
      brief: "compact",
      hush: "off",
      loom: "on",
    });
  });

  test("turns every engine off through its existing raw backend mode", () => {
    const brief = composeProductBriefControls({ initialVerbosity: "detailed" });
    const output = composeProductOutputControls();
    expect(applyCompressionControl(brief, output, "all.off")).toBe(
      "Brief, Hush, and Loom are off.",
    );
    expect(brief.getVerbosity()).toBe("raw");
    expect(output.getHushMode()).toBe("raw");
    expect(output.getLoomMode()).toBe("raw");

    applyCompressionControl(brief, output, "all.on");
    expect(brief.getFrontendMode()).toBe("detailed");
    expect(output.getHushState()).toBe("on");
    expect(output.getLoomState()).toBe("on");
  });

  test("reports an unattached engine instead of pretending it changed", () => {
    expect(applyCompressionControl(null, null, "hush.toggle")).toBe(
      "Hush controls are not attached to this shell.",
    );
  });
});
