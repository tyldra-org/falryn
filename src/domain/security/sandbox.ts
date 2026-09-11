import { z } from "zod";

/** Limits are independent of, and cannot enlarge, the owning task's budgets. */
export const MAX_SANDBOX_ROOTS = 8;
export const MAX_SANDBOX_LAUNCHES = 32;
export const MAX_SANDBOX_RECEIPT_BYTES = 64 * 1_024;
export const SANDBOX_EXPANSION_TTL_MS = 60_000;
export const SANDBOX_MODES = ["strict", "degraded", "off"] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

export function hasSandboxPathControl(value: string): boolean {
  return [...value].some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

const root = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => !hasSandboxPathControl(value));
export const sandboxExpansionSchema = z.strictObject({
  readRoots: z.array(root).max(MAX_SANDBOX_ROOTS).default([]),
  writeRoots: z.array(root).max(MAX_SANDBOX_ROOTS).default([]),
});
export type SandboxExpansion = z.infer<typeof sandboxExpansionSchema>;

export type SandboxBoundary = {
  readonly readRoots: readonly string[];
  readonly writeRoots: readonly string[];
  readonly network: {
    readonly destinations: readonly string[];
    readonly dns: "deny" | "allow";
    readonly proxy: "deny" | "allow";
    readonly listen: "deny" | "allow";
  };
  readonly processes: {
    readonly children: "deny" | "allow";
    readonly signals: "deny" | "allow";
    readonly debug: "deny" | "allow";
  };
  /** Existing artifact/temporary owners retain lifetime and cleanup authority. */
  readonly lifecyclePaths: readonly {
    readonly path: string;
    readonly owner: "temporary" | "cache" | "artifact";
  }[];
};

export type SandboxPolicy = {
  readonly generation: number;
  readonly mode: SandboxMode;
  readonly authority: "installation-compatibility" | "user";
  readonly boundary: SandboxBoundary;
};

export const OFFLINE_SANDBOX_NETWORK: SandboxBoundary["network"] = {
  destinations: [],
  dns: "deny",
  proxy: "deny",
  listen: "deny",
};
export const SINGLE_PROCESS_SANDBOX: SandboxBoundary["processes"] = {
  children: "deny",
  signals: "deny",
  debug: "deny",
};

export type SandboxInvocation = {
  readonly invocationId: string;
  readonly capabilityId: string;
  readonly source: "builtin" | "extension";
  readonly catalogGeneration: number;
  readonly policyGeneration: number;
  readonly inputFingerprint: string;
  readonly effect: string;
  readonly confirmationId: string | null;
  readonly resourceTaskId: string;
  readonly expiresAt: number;
  /** Granted by the trusted confirmation owner, never decoded from model input. */
  readonly expansion?: SandboxExpansionGrant;
};

export type SandboxExpansionGrant = {
  consume(invocation: SandboxInvocation, now: number): SandboxExpansion | null;
};

/** A one-shot grant is bound to exact intent and is consumed even if launch fails. */
export function createSandboxExpansionGrant(input: {
  readonly invocation: Omit<SandboxInvocation, "expansion">;
  readonly expansion: SandboxExpansion;
  readonly expiresAt: number;
}): SandboxExpansionGrant {
  const binding = { ...input.invocation };
  const expansion = sandboxExpansionSchema.parse(input.expansion);
  let consumed = false;
  return {
    consume(current, now) {
      if (consumed) return null;
      consumed = true;
      if (
        !Number.isFinite(now) ||
        now >= input.expiresAt ||
        now >= binding.expiresAt ||
        binding.confirmationId === null ||
        current.invocationId !== binding.invocationId ||
        current.capabilityId !== binding.capabilityId ||
        current.policyGeneration !== binding.policyGeneration ||
        current.catalogGeneration !== binding.catalogGeneration ||
        current.inputFingerprint !== binding.inputFingerprint ||
        current.effect !== binding.effect ||
        current.confirmationId !== binding.confirmationId ||
        current.resourceTaskId !== binding.resourceTaskId
      )
        return null;
      return { readRoots: [...expansion.readRoots], writeRoots: [...expansion.writeRoots] };
    },
  };
}

export const sandboxReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().min(1).max(128),
  invocationId: z.string().max(256).nullable(),
  capabilityId: z.string().max(256).nullable(),
  catalogGeneration: z.number().int().nonnegative().nullable(),
  policyGeneration: z.number().int().nonnegative(),
  inputFingerprint: z.string().max(256).nullable(),
  effect: z.string().max(64).nullable(),
  confirmationId: z.string().max(256).nullable(),
  resourceTaskId: z.string().max(256).nullable(),
  requestedMode: z.enum(SANDBOX_MODES),
  effectiveMode: z.enum(["strict", "off"]).nullable(),
  authority: z.enum(["installation-compatibility", "user"]),
  adapter: z.enum(["macos-seatbelt-v1", "none", "unavailable"]),
  state: z.enum(["prepared", "running", "terminated", "refused", "uncertain"]),
  pid: z.number().int().nonnegative().nullable(),
  readRoots: z.array(root).max(MAX_SANDBOX_ROOTS),
  writeRoots: z.array(root).max(MAX_SANDBOX_ROOTS),
  network: z.enum(["offline", "unrestricted"]),
  processes: z.enum(["single-process", "unrestricted"]),
  environment: z.literal("explicit"),
  credentialHandles: z.array(z.string().max(256)).max(16),
  expanded: z.boolean(),
  reason: z.string().max(128).nullable(),
  limitations: z.array(z.string().max(256)).max(8),
  remediation: z.string().max(512).nullable(),
});
export type SandboxReceipt = z.infer<typeof sandboxReceiptSchema>;

export type SandboxLaunchRequest = {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd?: string | undefined;
  readonly environment: Readonly<Record<string, string>>;
  readonly channel: "command" | "capture" | "pty" | "service";
  readonly signal?: AbortSignal | undefined;
  /** Resolved handles only; this port never resolves credentials or copies values to receipts. */
  readonly credentialHandles?: readonly string[];
};

export type SandboxLaunch = {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly cwd?: string | undefined;
  receipt(): SandboxReceipt;
  started(pid: number): void;
  finish(terminated: boolean): void;
  failed(): void;
};

export type SandboxPreparation =
  | { readonly kind: "ready"; readonly launch: SandboxLaunch }
  | { readonly kind: "refused"; readonly receipt: SandboxReceipt };

export type SandboxProbe = {
  readonly platform: string;
  readonly adapter: "macos-seatbelt-v1" | null;
  readonly status: "available" | "unsupported";
  readonly reason: string | null;
};

export type SandboxPort = {
  probe(): SandboxProbe;
  prepare(request: SandboxLaunchRequest): SandboxPreparation;
};

/** Native invocation scope shared by the gateway and the existing host supervisors. */
export type SandboxInvocationPort = {
  resolveExpansion(expansion: SandboxExpansion): SandboxExpansion | null;
  receipts(): readonly SandboxReceipt[];
  run<T>(
    invocation: SandboxInvocation,
    effect: () => Promise<T>,
  ): Promise<{
    readonly value: T;
    readonly receipts: readonly SandboxReceipt[];
  }>;
};

export function sandboxSummary(receipts: readonly SandboxReceipt[]): string | null {
  if (receipts.length === 0) return null;
  const refused = receipts.find((receipt) => receipt.state === "refused");
  if (refused !== undefined)
    return `Sandbox unavailable: ${refused.reason}. ${refused.remediation ?? ""}`.trim();
  if (receipts.some((receipt) => receipt.state === "uncertain"))
    return "Sandbox cleanup uncertain: process termination has not been confirmed.";
  if (receipts.some((receipt) => receipt.effectiveMode === "off"))
    return "Sandbox off: no OS filesystem, network or process isolation.";
  return "Sandbox strict: admitted filesystem roots, offline, subprocess creation blocked.";
}
