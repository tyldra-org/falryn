import { describe, expect, test } from "bun:test";

import { composeProductOutputControls } from "./product-output-controls.ts";

describe("composeProductOutputControls", () => {
  test("maps human on and off states onto backend Hush and Loom modes", () => {
    const controls = composeProductOutputControls();
    expect(controls.getHushState()).toBe("on");
    expect(controls.getHushMode()).toBe("hush");
    expect(controls.getLoomState()).toBe("on");
    expect(controls.getLoomMode()).toBe("loom");

    expect(controls.setHushState("off")).toEqual({ ok: true, value: "off" });
    expect(controls.setLoomState("off")).toEqual({ ok: true, value: "off" });
    expect(controls.getHushMode()).toBe("raw");
    expect(controls.getLoomMode()).toBe("raw");

    expect(controls.setHushState("on")).toEqual({ ok: true, value: "on" });
    expect(controls.setLoomState("on")).toEqual({ ok: true, value: "on" });
    expect(controls.getHushMode()).toBe("hush");
    expect(controls.getLoomMode()).toBe("loom");
  });

  test("rejects backend names at the human control boundary", () => {
    const controls = composeProductOutputControls();
    expect(controls.setHushState("raw")).toMatchObject({
      ok: false,
      error: { code: "unsupported-output-state", engine: "hush" },
    });
    expect(controls.setLoomState("raw")).toMatchObject({
      ok: false,
      error: { code: "unsupported-output-state", engine: "loom" },
    });
  });
});
