import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { release } from "node:os";
import {
  MAX_SANDBOX_LAUNCHES,
  MAX_SANDBOX_RECEIPT_BYTES,
  MAX_SANDBOX_ROOTS,
  OFFLINE_SANDBOX_NETWORK,
  type SandboxInvocation,
  type SandboxInvocationPort,
  type SandboxLaunch,
  type SandboxPolicy,
  type SandboxPort,
  type SandboxPreparation,
  type SandboxProbe,
  type SandboxReceipt,
  SINGLE_PROCESS_SANDBOX,
} from "../../domain/security/sandbox.ts";
import { canonicalSandboxRoot, SEATBELT_EXECUTABLE, seatbeltLaunch } from "./macos-sandbox.ts";

type Scope = {
  readonly invocation: SandboxInvocation;
  readonly launches: SandboxLaunch[];
  refusal?: SandboxReceipt;
};
const RECEIPT_REFUSAL_RESERVE = 2_048;
function receipts(scope: Scope): SandboxReceipt[] {
  return [
    ...scope.launches.map((launch) => launch.receipt()),
    ...(scope.refusal ? [scope.refusal] : []),
  ];
}
export type HostSandbox = SandboxPort & SandboxInvocationPort;

/** Trusted installation default for first-party host operations, never extension admission. */
export function installationSandboxPolicy(generation = 0): SandboxPolicy {
  return {
    generation,
    mode: "off",
    authority: "installation-compatibility",
    boundary: {
      readRoots: [],
      writeRoots: [],
      network: OFFLINE_SANDBOX_NETWORK,
      processes: SINGLE_PROCESS_SANDBOX,
      lifecyclePaths: [],
    },
  };
}

export function createHostSandbox(
  options: { readonly policy?: () => SandboxPolicy; readonly now?: () => number } = {},
): HostSandbox {
  const policy = options.policy ?? installationSandboxPolicy;
  const now = options.now ?? Date.now;
  const scopes = new AsyncLocalStorage<Scope>();
  const probe = (): SandboxProbe => {
    if (process.platform !== "darwin" || process.arch !== "arm64" || release() !== "25.6.0")
      return {
        platform: `${process.platform}-${process.arch}`,
        adapter: null,
        status: "unsupported",
        reason: "platform-not-qualified",
      };
    try {
      const stat = statSync(SEATBELT_EXECUTABLE);
      if (
        !stat.isFile() ||
        stat.uid !== 0 ||
        (stat.mode & 0o022) !== 0 ||
        (stat.mode & 0o111) === 0 ||
        stat.size > 256 * 1_024 ||
        createHash("sha256").update(readFileSync(SEATBELT_EXECUTABLE)).digest("hex") !==
          "abc5bb136d6b5cce8fa85d789f78e3326c51ca60cae637b2064adfb67a1dcd9a"
      )
        throw new Error("untrusted-helper");
      return {
        platform: "darwin-arm64",
        adapter: "macos-seatbelt-v1",
        status: "available",
        reason: null,
      };
    } catch {
      return {
        platform: "darwin-arm64",
        adapter: null,
        status: "unsupported",
        reason: "sandbox-helper-unavailable",
      };
    }
  };
  return {
    probe,
    resolveExpansion(expansion) {
      try {
        return {
          readRoots: expansion.readRoots.map(canonicalSandboxRoot),
          writeRoots: expansion.writeRoots.map(canonicalSandboxRoot),
        };
      } catch {
        return null;
      }
    },
    receipts: () => {
      const scope = scopes.getStore();
      return scope ? receipts(scope) : [];
    },
    async run<T>(invocation: SandboxInvocation, effect: () => Promise<T>) {
      const scope: Scope = { invocation, launches: [] };
      return scopes.run(scope, async () => {
        const value = await effect();
        return { value, receipts: receipts(scope) };
      });
    },
    prepare(request): SandboxPreparation {
      let current: SandboxPolicy;
      let invalidPolicy = false;
      try {
        current = policy();
      } catch {
        current = { ...installationSandboxPolicy(), mode: "strict", authority: "user" };
        invalidPolicy = true;
      }
      const scope = scopes.getStore();
      const invocation = scope?.invocation;
      let receipt: SandboxReceipt = {
        schemaVersion: 1,
        id: randomUUID(),
        invocationId: invocation?.invocationId ?? null,
        capabilityId: invocation?.capabilityId ?? null,
        catalogGeneration: invocation?.catalogGeneration ?? null,
        policyGeneration:
          Number.isSafeInteger(current.generation) && current.generation >= 0
            ? current.generation
            : 0,
        inputFingerprint: invocation?.inputFingerprint ?? null,
        effect: invocation?.effect ?? null,
        confirmationId: invocation?.confirmationId ?? null,
        resourceTaskId: invocation?.resourceTaskId ?? null,
        requestedMode: current.mode,
        effectiveMode: null,
        authority: current.authority,
        adapter: "unavailable",
        state: "prepared",
        pid: null,
        readRoots: [],
        writeRoots: [],
        network: "offline",
        processes: "single-process",
        environment: "explicit",
        credentialHandles: [...(request.credentialHandles ?? [])],
        expanded: false,
        reason: null,
        limitations: [],
        remediation: null,
      };
      const launch: SandboxLaunch = {
        executable: request.executable,
        argv: [...request.argv],
        environment: { ...request.environment },
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        receipt: () => structuredClone(receipt),
        started(pid) {
          receipt = { ...receipt, state: "running", pid };
        },
        finish(terminated) {
          receipt = { ...receipt, state: terminated ? "terminated" : "uncertain" };
        },
        failed() {
          receipt = {
            ...receipt,
            state: "refused",
            effectiveMode: null,
            reason: "sandbox-launch-failed",
          };
        },
      };
      const fitsReceiptBudget = (): boolean =>
        new TextEncoder().encode(JSON.stringify(scope ? receipts(scope) : [launch.receipt()]))
          .byteLength <=
        MAX_SANDBOX_RECEIPT_BYTES - RECEIPT_REFUSAL_RESERVE;
      const refuse = (reason: string): SandboxPreparation => {
        receipt = {
          ...receipt,
          readRoots: [],
          writeRoots: [],
          credentialHandles: [],
          state: "refused",
          effectiveMode: null,
          reason,
          remediation:
            "Inspect the trusted sandbox policy and platform qualification. No fallback was attempted.",
        };
        if (reason === "sandbox-receipt-limit" && scope !== undefined) {
          if (scope.launches.at(-1) === launch) scope.launches.pop();
          scope.refusal = launch.receipt();
        }
        return { kind: "refused", receipt: launch.receipt() };
      };
      if (scope !== undefined) {
        if (scope.launches.length >= MAX_SANDBOX_LAUNCHES || scope.refusal !== undefined) {
          const refused = refuse("sandbox-launch-limit");
          scope.refusal ??= launch.receipt();
          return refused;
        }
        scope.launches.push(launch);
      }
      if (invalidPolicy) return refuse("sandbox-invalid-policy");
      if (
        receipt.credentialHandles.length > 16 ||
        receipt.credentialHandles.some((handle) => handle.length > 256)
      )
        return refuse("sandbox-invalid-credential-handles");
      if (request.signal?.aborted) return refuse("sandbox-cancelled");
      if (!Number.isSafeInteger(current.generation) || current.generation < 0)
        return refuse("sandbox-invalid-policy");
      if (
        invocation !== undefined &&
        (invocation.policyGeneration !== current.generation || now() >= invocation.expiresAt)
      )
        return refuse("sandbox-stale-authority");
      if (invocation?.source === "extension" && current.mode !== "strict")
        return refuse("sandbox-extension-isolation-required");
      if (current.mode === "degraded") return refuse("sandbox-degraded-boundary-unqualified");
      if (current.mode === "off") {
        if (invocation?.expansion !== undefined) return refuse("sandbox-expansion-requires-strict");
        receipt = {
          ...receipt,
          effectiveMode: "off",
          adapter: "none",
          network: "unrestricted",
          processes: "unrestricted",
          limitations: [
            "No OS filesystem, network or process isolation.",
            "The existing supervisor owns process-tree termination and cleanup.",
          ],
        };
        if (!fitsReceiptBudget()) return refuse("sandbox-receipt-limit");
        return { kind: "ready", launch };
      }
      const available = probe();
      if (available.status !== "available")
        return refuse(available.reason ?? "sandbox-unavailable");
      if (request.channel === "pty") return refuse("sandbox-pty-not-qualified");
      const boundary = current.boundary;
      if (
        boundary.network.destinations.length !== 0 ||
        boundary.network.dns !== "deny" ||
        boundary.network.proxy !== "deny" ||
        boundary.network.listen !== "deny" ||
        Object.values(boundary.processes).some((value) => value !== "deny")
      )
        return refuse("sandbox-control-not-qualified");
      if (
        Object.keys(request.environment).some((key) =>
          /^(DYLD_|LD_|BUN_OPTIONS$|NODE_OPTIONS$)/.test(key),
        )
      )
        return refuse("sandbox-loader-environment-denied");
      const expansion = invocation?.expansion?.consume(invocation, now());
      if (invocation?.expansion !== undefined && expansion == null)
        return refuse("sandbox-expansion-stale-or-consumed");
      try {
        const readRoots = [
          ...new Set(
            [...boundary.readRoots, ...(expansion?.readRoots ?? [])].map(canonicalSandboxRoot),
          ),
        ];
        const writeRoots = [
          ...new Set(
            [
              ...boundary.writeRoots,
              ...(expansion?.writeRoots ?? []),
              ...boundary.lifecyclePaths.map((entry) => entry.path),
            ].map(canonicalSandboxRoot),
          ),
        ];
        if (readRoots.length > MAX_SANDBOX_ROOTS || writeRoots.length > MAX_SANDBOX_ROOTS)
          return refuse("sandbox-root-limit");
        const prepared = seatbeltLaunch(request, { ...boundary, readRoots, writeRoots }, [
          ...boundary.readRoots,
          ...boundary.writeRoots,
          ...(expansion?.readRoots ?? []),
          ...(expansion?.writeRoots ?? []),
        ]);
        receipt = {
          ...receipt,
          effectiveMode: "strict",
          adapter: "macos-seatbelt-v1",
          readRoots,
          writeRoots,
          expanded: expansion !== undefined && expansion !== null,
          limitations: [
            "Qualified only for Darwin 25.6.0 arm64; sandbox-exec is deprecated.",
            "Read access also includes the executable, /System/Library, /usr/lib, /Library/Apple and the root-directory entry.",
            "Metadata for admitted-root ancestors is readable to resolve filesystem aliases.",
            "Named hardware queries and own-process metadata are allowed; numeric sysctl and ptrace syscalls are denied.",
            "No protection from a privileged host or kernel compromise. No CPU or memory containment claim.",
            "Debugger attach was refused with and without the sandbox; independent adapter attribution is unqualified.",
            "Only supplied environment and stdin/stdout/stderr channels cross the boundary.",
          ],
        };
        if (!fitsReceiptBudget()) return refuse("sandbox-receipt-limit");
        return { kind: "ready", launch: { ...launch, ...prepared } };
      } catch {
        return refuse("sandbox-invalid-root-or-executable");
      }
    },
  };
}
