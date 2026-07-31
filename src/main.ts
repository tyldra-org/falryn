/**
 * Falryn's application bootstrap.
 *
 * It composes the control-flow lifecycle — clock, host signals, the root
 * cancellation scope, and the shutdown coordinator — and nothing else. There is
 * no product work to run yet, so the bootstrap shuts down immediately and
 * exits; the value of doing it here is that the composed lifecycle, including
 * the real process-signal adapter, is exercised by the compiled executable
 * rather than only in source mode.
 *
 * Product composition will be added through focused, issue-backed changes.
 */

import { createRuntimeLifecycle } from "./application/index.ts";
import { createSystemClock, type ShutdownReport } from "./domain/index.ts";
import { createProcessSignalPort } from "./integrations/index.ts";

export async function main(): Promise<ShutdownReport> {
  const lifecycle = createRuntimeLifecycle({
    clock: createSystemClock(),
    signals: createProcessSignalPort(),
  });

  try {
    return await lifecycle.requestShutdown();
  } finally {
    // Releases the host signal subscription. Without this the process stays
    // alive holding a listener nothing is waiting on.
    lifecycle.dispose();
  }
}

if (import.meta.main) {
  const report = await main();
  process.exitCode = report.outcome.kind === "completed" ? 0 : 1;
}
