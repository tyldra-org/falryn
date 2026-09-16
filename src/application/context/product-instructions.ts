import type { InstructionScope } from "../../domain/context/instruction-sources.ts";
import {
  INSTRUCTION_SOURCE_LIMITS,
  instructionDirectorySchema,
} from "../../domain/context/instruction-sources.ts";
import { NO_RETRY, workUnitId } from "../../domain/orchestration/work.ts";
import type { ProductTaskResources } from "../orchestration/product-resources.ts";
import type { InstructionPreparation, InstructionSourceOwner } from "./instruction-source-owner.ts";

export type ProductInstructions = {
  readonly owner: InstructionSourceOwner;
  readonly scope: Omit<InstructionScope, "execution">;
};

export async function prepareProductInstructions(input: {
  readonly instructions: ProductInstructions;
  readonly execution: string;
  readonly workspaceId: string;
  readonly configurationGeneration: string;
  readonly resources: ProductTaskResources;
  readonly signal: AbortSignal;
  readonly observe?: boolean;
}): Promise<InstructionPreparation> {
  const { resources, instructions } = input;
  const executed = await resources.execute({
    target: {
      kind: "instruction-source",
      workspaceId: input.workspaceId,
      configurationGeneration: input.configurationGeneration,
    },
    operation: "instruction-source-admission",
    attempt: input.execution,
    generation: resources.generation,
    inputBytes: 0,
    amounts: { operations: 1, bufferedBytes: INSTRUCTION_SOURCE_LIMITS.cacheBytes },
    signal: input.signal,
    unit: {
      id: workUnitId(`instructions:${input.execution}`),
      effect: "observation",
      priority: "interactive",
      conflictKeys: [],
      dependencies: [],
      deadline: null,
      expectedOutputBytes: INSTRUCTION_SOURCE_LIMITS.admittedBytes,
      retry: NO_RETRY,
      scopeId: null,
    },
    run: async (signal) => ({
      value: await instructions.owner.prepare(
        { ...instructions.scope, execution: input.execution },
        [],
        signal,
        input.observe ? undefined : input.configurationGeneration,
        input.observe ?? false,
      ),
      terminated: true,
    }),
  });
  return executed.kind === "completed"
    ? executed.value
    : {
        ok: false,
        code: input.signal.aborted ? "cancelled" : "instruction-resource-refused",
        sources: [],
      };
}

/** Definition metadata narrows an admitted root; it cannot select a new root. */
export function narrowInstructionScope(
  parent: ProductInstructions,
  kind: "child" | "workflow",
  directory: string = parent.scope.directory,
): ProductInstructions {
  directory = instructionDirectorySchema.parse(directory);
  const base = parent.scope.directory;
  if (base !== "" && directory !== base && !directory.startsWith(`${base}/`))
    throw new Error("instruction-scope-not-admitted");
  return { ...parent, scope: { ...parent.scope, kind, directory } };
}

/** Reload uses the same process capacity and publication owner as turn admission. */
export async function refreshRuntimeInstructions(
  runtime: import("../runtime/product-agent-runtime.ts").ProductAgentRuntime,
  signal = new AbortController().signal,
): Promise<void> {
  if (!runtime.instructions) return;
  const generation = String(runtime.correlation.configurationGeneration);
  const task = runtime.resources.openTask(generation);
  try {
    await prepareProductInstructions({
      instructions: runtime.instructions,
      resources: task,
      execution: `reload:${task.id}`,
      workspaceId: String(runtime.correlation.workspaceId),
      configurationGeneration: generation,
      signal,
      observe: true,
    });
  } finally {
    task.close();
  }
}
