import { expect, spyOn, test } from "bun:test";
import type { ReactNode } from "react";
import { frameOf } from "../harness.tsx";
import { ShellErrorBoundary } from "./shell-error-boundary.tsx";

function BrokenFrame(): ReactNode {
  throw new Error("foreign render detail that must not reach the screen");
}

test("a render failure becomes a safe frame with an exit instruction", async () => {
  const consoleError = spyOn(console, "error").mockImplementation(() => {});
  let frame: string;
  try {
    frame = await frameOf(
      <ShellErrorBoundary>
        <BrokenFrame />
      </ShellErrorBoundary>,
      { shape: { columns: 70, rows: 6 } },
    );
  } finally {
    consoleError.mockRestore();
  }

  expect(frame).toContain("Falryn could not render this frame.");
  expect(frame).toContain("Press Ctrl+C to exit and restore the terminal.");
  expect(frame).not.toContain("foreign render detail");
});
