/** Data reset and uninstall command family. */

import { fromRemovalRefusal, fromUnknown } from "../../application/index.ts";
import type { RemovalOutcome, RemovalPlan, TerminalOutcome } from "../../domain/index.ts";
import type { DataCommandArguments } from "../command-tree.ts";
import type { CommandResultOf } from "../result.ts";
import type { ServiceProvider } from "../services.ts";
import { MUTATION_NOT_OBSERVED, resultFor } from "./shared.ts";

export type DataRemovalPayload = {
  readonly plan: RemovalPlan;
  readonly execution: RemovalOutcome | null;
  readonly confirmation: "not-requested" | "applied" | "refused";
};

type RemovalCommand = "data.reset" | "data.uninstall";

async function runDataRemoval<Command extends RemovalCommand>(
  command: Command,
  services: ServiceProvider,
  arguments_: DataCommandArguments,
  signal?: AbortSignal,
  onMutationStart?: () => void,
): Promise<CommandResultOf<Command, DataRemovalPayload>> {
  try {
    const localData = services().removalData;
    const plan =
      command === "data.reset"
        ? await localData.planReset({ classes: arguments_.classes }, signal)
        : await localData.planUninstall(signal);

    if (arguments_.confirmation === null) {
      return resultFor(command, { plan, execution: null, confirmation: "not-requested" });
    }

    // The plan was derived in this invocation, after the user saw the prior
    // preview. A changed root, count, or path makes its identity differ before
    // the executor is allowed to start a deletion.
    if (plan.planId !== arguments_.confirmation) {
      return resultFor(
        command,
        { plan, execution: null, confirmation: "refused" },
        [
          fromRemovalRefusal(
            { code: "plan-mismatch", expected: plan.planId, confirmed: arguments_.confirmation },
            { operation: "apply removal plan" },
          ),
        ],
        { kind: "failed", effect: "none" },
        MUTATION_NOT_OBSERVED,
      );
    }
    onMutationStart?.();
    const executed = await localData.executeRemoval(
      plan,
      { planId: arguments_.confirmation },
      signal,
    );
    if (!executed.ok) {
      return resultFor(
        command,
        { plan, execution: null, confirmation: "refused" },
        [fromRemovalRefusal(executed.error, { operation: "apply removal plan" })],
        { kind: "failed", effect: "none" },
        MUTATION_NOT_OBSERVED,
      );
    }

    const outcome: TerminalOutcome | undefined =
      executed.value.effect === "partial"
        ? { kind: "failed", effect: "partial" as const }
        : undefined;
    return resultFor(
      command,
      { plan, execution: executed.value, confirmation: "applied" },
      [],
      outcome,
      { intent: "mutate", observed: executed.value.effect },
    );
  } catch (error) {
    return resultFor(
      command,
      null,
      [fromUnknown(error, { operation: "manage local data" })],
      undefined,
      {
        intent: arguments_.confirmation === null ? "none" : "mutate",
        observed: "uncertain",
      },
    );
  }
}

/** Plans or applies a selective local-data reset. */
export function runDataReset(
  services: ServiceProvider,
  arguments_: DataCommandArguments,
  signal?: AbortSignal,
  onMutationStart?: () => void,
): Promise<CommandResultOf<"data.reset", DataRemovalPayload>> {
  return runDataRemoval("data.reset", services, arguments_, signal, onMutationStart);
}

/** Plans or applies the complete registered local-data uninstall. */
export function runDataUninstall(
  services: ServiceProvider,
  arguments_: DataCommandArguments,
  signal?: AbortSignal,
  onMutationStart?: () => void,
): Promise<CommandResultOf<"data.uninstall", DataRemovalPayload>> {
  return runDataRemoval("data.uninstall", services, arguments_, signal, onMutationStart);
}
