import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { duration } from "../../domain/foundation/index.ts";
import {
  createSandboxExpansionGrant,
  OFFLINE_SANDBOX_NETWORK,
  type SandboxInvocation,
  type SandboxPolicy,
  SINGLE_PROCESS_SANDBOX,
} from "../../domain/security/sandbox.ts";
import { createHostCommandRunner } from "../process/host-commands.ts";
import { createHostProcessCapturePort } from "../process/host-process-capture.ts";
import { createHostSandbox, installationSandboxPolicy } from "./host-sandbox.ts";

const invocation: SandboxInvocation = {
  invocationId: "sandbox-invocation",
  capabilityId: "builtin:process/run@1",
  source: "builtin",
  catalogGeneration: 1,
  policyGeneration: 1,
  inputFingerprint: "exact",
  effect: "mutation",
  confirmationId: null,
  resourceTaskId: "sandbox-task",
  expiresAt: Date.now() + 60_000,
};
const hostTest = createHostSandbox().probe().status === "available" ? test : test.skip;
function strictPolicy(root: string): SandboxPolicy {
  return {
    generation: 1,
    mode: "strict",
    authority: "user",
    boundary: {
      readRoots: [],
      writeRoots: [root],
      network: OFFLINE_SANDBOX_NETWORK,
      processes: SINGLE_PROCESS_SANDBOX,
      lifecyclePaths: [],
    },
  };
}
function request(script: string, cwd?: string) {
  return {
    executable: process.execPath,
    argv: ["-e", script],
    environment: { PATH: "/usr/bin:/bin" },
    ...(cwd === undefined ? {} : { cwd }),
    timeoutMs: duration(5_000),
    maxOutputBytes: 8_192,
  };
}

describe("host sandbox", () => {
  test("off is explicit in command and capture receipts and never inherited by extensions", async () => {
    const sandbox = createHostSandbox({ policy: () => installationSandboxPolicy(1) });
    const command = createHostCommandRunner({ sandbox });
    const first = await sandbox.run(invocation, () => command.run(request('console.log("ok")')));
    expect(first.value.kind).toBe("exited");
    expect(first.receipts[0]).toMatchObject({
      effectiveMode: "off",
      state: "terminated",
      invocationId: invocation.invocationId,
      network: "unrestricted",
    });
    const extension = await sandbox.run({ ...invocation, source: "extension" }, () =>
      command.run(request('throw new Error("must not run")')),
    );
    expect(extension.value).toMatchObject({
      kind: "spawn-failed",
      code: "sandbox-extension-isolation-required",
    });
    expect(extension.receipts[0]?.pid).toBeNull();
    const capture = await createHostProcessCapturePort({ sandbox }).run(
      request('console.log("captured")'),
    );
    expect(capture.ok && capture.value.sandbox?.effectiveMode).toBe("off");
  });
  test("degraded, stale, cancelled and unqualified controls fail before a child exists", async () => {
    let policy = { ...installationSandboxPolicy(1), mode: "degraded" as const } as SandboxPolicy;
    const sandbox = createHostSandbox({ policy: () => policy });
    const command = createHostCommandRunner({ sandbox });
    const denied = await sandbox.run(invocation, () =>
      command.run(request('throw new Error("must not run")')),
    );
    expect(denied.receipts[0]).toMatchObject({
      state: "refused",
      pid: null,
      reason: "sandbox-degraded-boundary-unqualified",
    });
    policy = installationSandboxPolicy(2);
    const stale = await sandbox.run(invocation, () =>
      command.run(request('throw new Error("must not run")')),
    );
    expect(stale.receipts[0]?.reason).toBe("sandbox-stale-authority");
    const signal = AbortSignal.abort();
    const cancelled = sandbox.prepare({ ...request(""), channel: "capture", signal });
    expect(cancelled.kind === "refused" && cancelled.receipt.reason).toBe("sandbox-cancelled");
    policy = {
      ...strictPolicy(tmpdir()),
      boundary: {
        ...strictPolicy(tmpdir()).boundary,
        processes: { ...SINGLE_PROCESS_SANDBOX, children: "allow" },
      },
    };
    const unsupported = sandbox.prepare({ ...request(""), channel: "capture" });
    expect(unsupported.kind).toBe("refused");
  });
  test("an unsupported host returns a named strict refusal", () => {
    const sandbox = createHostSandbox({ policy: () => strictPolicy(tmpdir()) });
    if (sandbox.probe().status === "available") return;
    const prepared = sandbox.prepare({ ...request(""), channel: "capture" });
    expect(prepared.kind === "refused" && prepared.receipt.pid).toBeNull();
    expect(prepared.kind === "refused" && prepared.receipt.effectiveMode).toBeNull();
  });
  hostTest(
    "kernel restricts hostile filesystem and process effects with positive controls",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "falryn-sandbox-"));
      const root = join(directory, "admitted");
      const outside = join(directory, "outside");
      try {
        await mkdir(root);
        await mkdir(outside);
        await writeFile(join(outside, "sentinel"), "private fixture");
        await symlink(outside, join(root, "escape"));
        const sandbox = createHostSandbox({ policy: () => strictPolicy(root) });
        const capture = createHostProcessCapturePort({ sandbox });
        const script = `
        const fs = require("node:fs"); const result = {};
        const attempt = (key, fn) => { try { fn(); result[key] = "allowed"; } catch { result[key] = "denied"; } };
        attempt("inside", () => fs.writeFileSync(${JSON.stringify(join(root, "inside"))}, "ok"));
        attempt("read", () => fs.readFileSync(${JSON.stringify(join(outside, "sentinel"))}));
        attempt("write", () => fs.writeFileSync(${JSON.stringify(join(outside, "written"))}, "bad"));
        attempt("symlink", () => fs.readFileSync(${JSON.stringify(join(root, "escape/sentinel"))}));
        attempt("rename", () => fs.renameSync(${JSON.stringify(join(outside, "sentinel"))}, ${JSON.stringify(join(root, "stolen"))}));
        attempt("child", () => Bun.spawnSync([process.execPath, "-e", "process.exit(0)"], {env:{}, stdout:"ignore", stderr:"ignore"}));
        attempt("signal", () => process.kill(process.ppid, 0));
        console.log(JSON.stringify(result));`;
        const result = await sandbox.run(invocation, () => capture.run(request(script, root)));
        expect(result.value.ok).toBe(true);
        if (!result.value.ok) return;
        expect(result.value.value.exit.exitCode).toBe(0);
        expect(JSON.parse(result.value.value.stdout.inlineText ?? "null")).toEqual({
          inside: "allowed",
          read: "denied",
          write: "denied",
          symlink: "denied",
          rename: "denied",
          child: "denied",
          signal: "denied",
        });
        expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("private fixture");
        expect(result.receipts[0]).toMatchObject({
          effectiveMode: "strict",
          state: "terminated",
          adapter: "macos-seatbelt-v1",
        });
        const off = await createHostProcessCapturePort().run(request(script, root));
        expect(off.ok && JSON.parse(off.value.stdout.inlineText ?? "null")).toEqual({
          inside: "allowed",
          read: "allowed",
          write: "allowed",
          symlink: "allowed",
          rename: "allowed",
          child: "allowed",
          signal: "allowed",
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
  hostTest("one-shot roots expire and cannot authorize a second executable launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "falryn-sandbox-grant-"));
    try {
      const sandbox = createHostSandbox({ policy: () => strictPolicy(root), now: () => 100 });
      const binding = { ...invocation, confirmationId: "confirmed", expiresAt: 300 };
      const expansion = createSandboxExpansionGrant({
        invocation: binding,
        expansion: { readRoots: [root], writeRoots: [] },
        expiresAt: 200,
      });
      const result = await sandbox.run({ ...binding, expansion }, async () => {
        const first = sandbox.prepare({ ...request(""), channel: "capture" });
        const second = sandbox.prepare({ ...request(""), channel: "capture" });
        return [first.kind, second.kind];
      });
      expect(result.value).toEqual(["ready", "refused"]);
      expect(result.receipts[1]?.reason).toBe("sandbox-expansion-stale-or-consumed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  hostTest("timeout terminates a strict child", async () => {
    const root = await mkdtemp(join(tmpdir(), "falryn-sandbox-stop-"));
    try {
      const sandbox = createHostSandbox({ policy: () => strictPolicy(root) });
      const result = await createHostProcessCapturePort({ sandbox }).run({
        ...request("setInterval(() => {}, 100)", root),
        timeoutMs: duration(200),
      });
      expect(result.ok && result.value.stop.kind).toBe("timed-out");
      expect(result.ok && result.value.sandbox?.state).toBe("terminated");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("launch and receipt pressure refuse before effects with bounded durable evidence", async () => {
  const sandbox = createHostSandbox({ policy: () => installationSandboxPolicy(1) });
  const result = await sandbox.run(invocation, async () => {
    let denied = 0;
    for (let count = 0; count < 80; count++) {
      const prepared = sandbox.prepare({ ...request(""), channel: "command" });
      if (prepared.kind === "refused") denied++;
    }
    return denied;
  });
  expect(result.value).toBe(48);
  expect(result.receipts).toHaveLength(33);
  expect(result.receipts.at(-1)).toMatchObject({ reason: "sandbox-launch-limit", pid: null });
  expect(new TextEncoder().encode(JSON.stringify(result.receipts)).byteLength).toBeLessThan(65_536);
});

test("export retains a valid boundary receipt while removing handle material", async () => {
  const { redactExportValue } = await import("../../domain/sessions/export.ts");
  const { sandboxReceiptSchema } = await import("../../domain/security/sandbox.ts");
  const { createRuntimeRedactor } = await import("../../application/diagnostics/index.ts");
  const prepared = createHostSandbox().prepare({
    ...request(""),
    channel: "command",
    credentialHandles: ["handle-secret"],
  });
  if (prepared.kind !== "ready") throw new Error("fixture unexpectedly refused");
  const receipt = prepared.launch.receipt();
  const exported = redactExportValue(receipt, createRuntimeRedactor(), []);
  expect(exported.ok).toBe(true);
  expect(exported.ok && sandboxReceiptSchema.safeParse(exported.value).success).toBe(true);
  expect(JSON.stringify(exported)).not.toContain("handle-secret");
  expect(exported.ok && sandboxReceiptSchema.parse(exported.value).authority).toBe(
    "installation-compatibility",
  );
  expect(
    JSON.stringify(
      redactExportValue({ ...receipt, authority: "credential-value" }, createRuntimeRedactor(), []),
    ),
  ).not.toContain("credential-value");
});

test("receipt byte pressure and malformed host metadata retain valid bounded refusals", async () => {
  const { sandboxReceiptSchema } = await import("../../domain/security/sandbox.ts");
  const sandbox = createHostSandbox({ policy: () => installationSandboxPolicy(1) });
  const result = await sandbox.run(invocation, async () => {
    for (let i = 0; i < 32; i++)
      sandbox.prepare({
        ...request(""),
        channel: "command",
        credentialHandles: Array(16).fill("h".repeat(256)),
      });
  });
  expect(result.receipts.some((receipt) => receipt.reason === "sandbox-receipt-limit")).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(result.receipts))).toBeLessThan(65_536);
  expect(result.receipts.every((receipt) => sandboxReceiptSchema.safeParse(receipt).success)).toBe(
    true,
  );
  for (const generation of [-1, NaN]) {
    const prepared = createHostSandbox({
      policy: () => installationSandboxPolicy(generation),
    }).prepare({ ...request(""), channel: "command" });
    expect(prepared.kind).toBe("refused");
    expect(
      prepared.kind === "refused" && sandboxReceiptSchema.safeParse(prepared.receipt).success,
    ).toBe(true);
  }
  const handles = sandbox.prepare({
    ...request(""),
    channel: "command",
    credentialHandles: ["h".repeat(257)],
  });
  expect(handles.kind === "refused" && handles.receipt.reason).toBe(
    "sandbox-invalid-credential-handles",
  );
});
