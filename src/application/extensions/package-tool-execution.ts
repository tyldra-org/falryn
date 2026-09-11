import { randomUUID } from "node:crypto";
import {
  canonicalDigest,
  canonicalJson,
  ExtensionInputError,
} from "../../domain/extensions/canonical.ts";
import {
  initialHealthResult,
  PACKAGE_HEALTH_LIMITS,
  PACKAGE_TOOL_PROTOCOL,
  type PackageHealthRecord,
  type PackageHealthStore,
} from "../../domain/extensions/package-health.ts";
import { conflictKey, NO_RETRY, workUnitId } from "../../domain/orchestration/work.ts";
import type { ToolInvocationOutcome } from "../../domain/tools/index.ts";
import { capacityScope } from "../orchestration/product-resources.ts";
import type { ToolRunnerRequest } from "../runtime/tool-call-loop.ts";
import {
  createPackageExecutionAdmission,
  type PackageAdmissionOptions,
} from "./package-execution-admission.ts";
import type { PackageHealthHost } from "./package-health.ts";
import { projectPackageProcessResult } from "./package-process-projection.ts";

/** A deterministic receipt key ties retries to the gateway's original invocation. */
function operationKey(id: string): string {
  const hex = canonicalDigest({ nativeToolInvocation: id }).slice(7);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function project(record: PackageHealthRecord): ToolInvocationOutcome {
  const result = projectPackageProcessResult(record.result);
  const sandbox = result.sandbox === null ? {} : { sandbox: [result.sandbox] };
  if (result.state === "completed" && result.value !== undefined && result.terminated)
    return { ...sandbox, status: "completed", output: result.value, effect: "completed" };
  if (!result.terminated)
    return {
      ...sandbox,
      status: "uncertain",
      effect: "uncertain",
      recoveryHint: `${result.code}; operation=${record.operation}`,
    };
  if (result.cleanup === "removed" && result.value === undefined) {
    if (result.code === "cancelled") return { ...sandbox, status: "cancelled", effect: "none" };
    if (result.code.includes("timeout")) return { ...sandbox, status: "timed-out", effect: "none" };
  }
  return {
    ...sandbox,
    status: "failed",
    reason: `${result.code}; operation=${record.operation}`,
    effect: result.value !== undefined ? "completed" : result.terminated ? "none" : "uncertain",
  };
}

/** Invocation always re-enters installed admission and the shared resource/process owners. */
export function createPackageToolExecution(
  options: Omit<PackageAdmissionOptions, "protocol"> & {
    store: PackageHealthStore;
    execution: PackageHealthHost;
  },
) {
  const capture = createPackageExecutionAdmission({ ...options, protocol: PACKAGE_TOOL_PROTOCOL });
  return async (input: {
    packageId: string;
    expectedRevision: number;
    contribution: string;
    activation: string;
    request: ToolRunnerRequest;
    validateOutput(value: unknown): boolean;
  }): Promise<ToolInvocationOutcome> => {
    const state: { record: PackageHealthRecord | null } = { record: null };
    const request = input.request;
    const settle = (record: PackageHealthRecord) => {
      request.processTask?.reportTermination?.(record.result.terminated);
      return project(record);
    };
    const task = request.taskResources;
    if (!task)
      return {
        status: "unavailable",
        reason: "package-tool-resources-unavailable",
        effect: "none",
      };
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(PACKAGE_HEALTH_LIMITS.wallTimeMs),
    ]);
    try {
      const encoded = canonicalJson(request.input);
      if (Buffer.byteLength(encoded) > 8_192)
        throw new ExtensionInputError("package-tool-input-exhausted");
      const operation = operationKey(String(request.invocationId));
      const fingerprint = canonicalDigest({
        activation: input.activation,
        contribution: input.contribution,
        packageId: input.packageId,
        revision: input.expectedRevision,
        input: encoded,
        capability: request.capabilityId,
      });
      const prior = options.store.get(operation);
      if (!prior.ok) throw new ExtensionInputError(prior.error.code);
      if (prior.value) {
        if (prior.value.fingerprint !== fingerprint)
          throw new ExtensionInputError("package-tool-invocation-reused");
        return settle(prior.value);
      }
      const identity = {
        packageId: input.packageId,
        expectedRevision: input.expectedRevision,
        contribution: input.contribution,
        requiredControls: [],
      };
      const admitted = await capture(identity, signal);
      const pending = options.store.pending(input.contribution);
      if (!pending.ok) throw new ExtensionInputError(pending.error.code);
      if (pending.value)
        throw new ExtensionInputError(
          `unresolved-package-process; operation=${pending.value.operation}`,
        );
      const failures = options.store.failures(input.contribution, admitted.generation);
      if (!failures.ok) throw new ExtensionInputError(failures.error.code);
      if (failures.value >= PACKAGE_HEALTH_LIMITS.crashes)
        throw new ExtensionInputError("package-tool-quarantined");
      const initial: PackageHealthRecord = {
        operation,
        fingerprint,
        packageId: input.packageId,
        revision: 1,
        result: initialHealthResult({
          protocol: PACKAGE_TOOL_PROTOCOL,
          attempt: randomUUID(),
          package: admitted.installed.current?.identityDigest ?? "",
          contribution: input.contribution,
          generation: admitted.generation,
        }),
        birth: null,
        directory: null,
      };
      const save = (next: PackageHealthRecord) => {
        const saved = options.store.save(next, state.record?.revision ?? 0);
        if (!saved.ok) throw new ExtensionInputError(saved.error.code);
        state.record = next;
      };
      const current = async () => {
        try {
          return (await capture(identity, signal)).generation === admitted.generation;
        } catch {
          return false;
        }
      };
      const active: { process?: Promise<PackageHealthRecord> } = {};
      const result = await task.execute({
        operation,
        attempt: initial.result.binding.attempt,
        generation: task.generation,
        inputBytes: Buffer.byteLength(encoded),
        amounts: {
          processes: 1,
          requests: 3,
          attempts: 1,
          concurrency: 1,
          bufferedBytes: 131_072,
          diskBytes: admitted.installed.current?.byteLength ?? 0,
        },
        unknownDimensions: ["cpuMs", "memoryBytes"],
        signal,
        scopes: [
          {
            scope: capacityScope("process", "falryn", "package-health", "processes", "occupancy"),
            amount: 1,
            limit: PACKAGE_HEALTH_LIMITS.processes,
          },
          {
            scope: capacityScope("package", input.packageId, "health", "processes", "occupancy"),
            amount: 1,
            limit: PACKAGE_HEALTH_LIMITS.packageProcesses,
          },
        ],
        unit: {
          id: workUnitId(operation),
          effect: "observation",
          priority: "interactive",
          conflictKeys: [conflictKey("package", input.packageId)],
          dependencies: [],
          deadline: null,
          expectedOutputBytes: 131_072,
          retry: NO_RETRY,
          scopeId: null,
        },
        async run(admittedSignal) {
          if (!(await current())) throw new ExtensionInputError("stale-package-tool-authority");
          save(initial);
          active.process = options.execution.run({
            record: initial,
            snapshot: admitted.snapshot,
            declaration: admitted.declaration,
            signal: admittedSignal,
            resourceTaskId: task.id,
            expiresAt: Math.min(task.expiresAt, Date.now() + PACKAGE_HEALTH_LIMITS.wallTimeMs),
            catalogGeneration: admitted.catalogGeneration,
            confirmation: input.activation,
            current,
            save,
            invocation: { input: request.input, validateOutput: input.validateOutput },
          });
          const completed = await active.process;
          return { value: completed, terminated: completed.result.terminated };
        },
      });
      // Cancellation may settle the scheduler first. Its process and database still belong here.
      if (active.process) return settle(await active.process);
      return result.kind === "completed"
        ? settle(result.value)
        : {
            status: "failed",
            reason: result.receipt.state,
            effect: result.receipt.uncertain ? "uncertain" : "none",
          };
    } catch (error) {
      const reason = error instanceof ExtensionInputError ? error.code : "package-tool-failed";
      if (state.record && !state.record.result.terminated)
        return {
          status: "uncertain",
          effect: "uncertain",
          recoveryHint: `${reason}; operation=${state.record.operation}`,
        };
      return {
        status: "failed",
        reason: state.record ? `${reason}; operation=${state.record.operation}` : reason,
        effect: state.record?.result.value !== undefined ? "completed" : "none",
      };
    }
  };
}
