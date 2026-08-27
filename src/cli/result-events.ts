/** Non-serializable lifecycle side channel for JSONL command projection (#787). */

import type { RuntimeEvent } from "../domain/index.ts";
import type { RunCommandResult } from "./commands.ts";

const EVENTS = new WeakMap<RunCommandResult, readonly RuntimeEvent[]>();

export function attachResultEvents<Result extends RunCommandResult>(
  result: Result,
  events: readonly RuntimeEvent[],
): Result {
  EVENTS.set(result, [...events]);
  return result;
}

export function resultEvents(result: RunCommandResult): readonly RuntimeEvent[] | null {
  return EVENTS.get(result) ?? null;
}
