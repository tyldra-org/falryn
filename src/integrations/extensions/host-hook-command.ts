import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { release } from "node:os";
import { dirname, join } from "node:path";
import type { HookCommandPort } from "../../application/extensions/hook-command-port.ts";
import { HookExecutionError } from "../../application/tools/tool-hook-invocation.ts";
import { bytesDigest, packageRelativePath } from "../../domain/extensions/canonical.ts";
import { HOOK_PYTHON_PROFILE } from "../../domain/extensions/hook-command-profile.ts";
import { HOOK_LIMITS } from "../../domain/extensions/hook-points.ts";
import { decodeHookResponse, encodeHookInput } from "../../domain/extensions/hook-protocol.ts";
import { duration } from "../../domain/foundation/index.ts";
import { OFFLINE_SANDBOX_NETWORK, SINGLE_PROCESS_SANDBOX } from "../../domain/security/sandbox.ts";
import { type HookHandlerFacts, hookHandlerFactsSchema } from "../../domain/tools/hook-evidence.ts";
import { createHostProcessCapturePort } from "../process/host-process-capture.ts";
import { createHostSandbox } from "../security/host-sandbox.ts";

// This exact Apple runtime is optional. No PATH search, installation or interpreter fallback.
const PYTHON_ROOT =
  "/Applications/Xcode.app/Contents/Developer/Library/Frameworks/Python3.framework/Versions/3.9";
export const HOOK_PYTHON_EXECUTABLE = join(
  PYTHON_ROOT,
  "Resources/Python.app/Contents/MacOS/Python",
);
export function qualifiedHookPython(): boolean {
  if (process.platform !== "darwin" || process.arch !== "arm64" || release() !== "27.0.0")
    return false;
  try {
    for (const [file, digest] of [
      [HOOK_PYTHON_EXECUTABLE, "07470fa2e1aec690aa62061af6e0f65fe9bf3169a74a16384592fb1ff1cb320f"],
      [
        join(PYTHON_ROOT, "Python3"),
        "44ff033892426c3e077330968ee007b1b1aad433f8ebcda7970eb0d113532032",
      ],
    ]) {
      if (!file || !digest) return false;
      const stat = lstatSync(file);
      if (
        !stat.isFile() ||
        stat.uid !== 0 ||
        (stat.mode & 0o022) !== 0 ||
        createHash("sha256").update(readFileSync(file)).digest("hex") !== digest
      )
        return false;
    }
    return (
      realpathSync(PYTHON_ROOT) === PYTHON_ROOT &&
      createHostSandbox().probe().status === "available"
    );
  } catch {
    return false;
  }
}

/** Exact installed bytes are copied into a read-only invocation directory before sandbox launch. */
export function createHostHookCommand(options: {
  directory: string;
  policy(): { mode: string; generation: number };
}): HookCommandPort {
  return {
    available: () => options.policy().mode === "strict" && qualifiedHookPython(),
    async run(input) {
      if (input.context.signal.aborted) throw new HookExecutionError("cancelled");
      const handler = input.registration.handler;
      if (
        handler.kind !== "external-command-v1" ||
        handler.executionProfile !== HOOK_PYTHON_PROFILE ||
        handler.executable !== "python3.9" ||
        !qualifiedHookPython() ||
        options.policy().mode !== "strict"
      )
        throw new HookExecutionError("hook-execution-profile-unavailable");
      const policy = options.policy();
      await mkdir(options.directory, { recursive: true, mode: 0o700 });
      if (lstatSync(options.directory).isSymbolicLink())
        throw new HookExecutionError("hook-root-unavailable");
      const directory = await mkdtemp(join(realpathSync(options.directory), "hook-"));
      let terminated = true;
      const facts: Extract<HookHandlerFacts, { kind: "process" }> = {
        kind: "process",
        transport: "not-started",
        exitCode: null,
        signal: null,
        response: "missing",
        stdoutBytes: 0,
        stderrBytes: 0,
        omittedBytes: 0,
        effects: "none",
      };
      const execute = async () => {
        if (!input.snapshot.files.some((file) => file.path === handler.entrypoint))
          throw new HookExecutionError("hook-entrypoint-missing");
        for (const file of input.snapshot.files) {
          if (input.context.signal.aborted) throw new HookExecutionError("cancelled");
          if (packageRelativePath(file.path) !== file.path)
            throw new HookExecutionError("hook-path-invalid");
          const target = join(directory, file.path);
          await mkdir(dirname(target), { recursive: true, mode: 0o700 });
          await writeFile(target, file.bytes, { flag: "wx", mode: 0o400 });
          if (bytesDigest(readFileSync(target)) !== bytesDigest(file.bytes))
            throw new HookExecutionError("hook-package-changed");
        }
        await chmod(directory, 0o500);
        const sandbox = createHostSandbox({
          policy: () => ({
            generation: options.policy().generation,
            mode: options.policy().mode === "strict" ? "strict" : "degraded",
            authority: "user",
            boundary: {
              readRoots: [directory, PYTHON_ROOT],
              writeRoots: [],
              network: OFFLINE_SANDBOX_NETWORK,
              processes: SINGLE_PROCESS_SANDBOX,
              lifecyclePaths: [],
            },
          }),
        });
        if (!(await input.current()) || input.context.signal.aborted)
          throw new HookExecutionError("hook-authority-stale");
        const remaining = input.context.expiresAt - Date.now();
        if (remaining <= 0) throw new HookExecutionError("timed-out");
        terminated = false;
        facts.transport = "uncertain";
        facts.effects = "unknown";
        const result = await sandbox.run(
          {
            invocationId: input.wire.invocationId,
            capabilityId: input.wire.contribution.contributionId,
            source: "extension",
            catalogGeneration: input.wire.envelope.ownerGeneration,
            policyGeneration: policy.generation,
            inputFingerprint: createHash("sha256")
              .update(encodeHookInput(input.wire))
              .digest("hex"),
            effect: "observation",
            confirmationId: null,
            resourceTaskId: input.context.resourceTaskId,
            expiresAt: input.context.expiresAt,
          },
          () =>
            createHostProcessCapturePort({ sandbox }).run({
              executable: HOOK_PYTHON_EXECUTABLE,
              argv: [
                "-I",
                "-S",
                "-B",
                "-X",
                "utf8",
                join(directory, handler.entrypoint),
                ...handler.argv,
              ],
              cwd: directory,
              environment: {},
              stdin: encodeHookInput(input.wire),
              signal: input.context.signal,
              timeoutMs: duration(remaining),
              maxOutputBytes: HOOK_LIMITS.responseBytes + HOOK_LIMITS.diagnosticBytes,
              maxCaptureBytes: HOOK_LIMITS.responseBytes + HOOK_LIMITS.diagnosticBytes,
              maxInlineBytes: HOOK_LIMITS.responseBytes,
              maxLineBytes: HOOK_LIMITS.responseBytes,
              maxArtifactBytes: HOOK_LIMITS.responseBytes,
              retainChunkEvents: false,
              ownership: { started: async () => {}, event: async () => {} },
            }),
        );
        if (!result.value.ok) {
          facts.transport = "failed";
          terminated = result.receipts.every(
            (receipt) => receipt.state === "terminated" || receipt.state === "refused",
          );
          throw new HookExecutionError(
            "hook-process-unavailable",
            terminated ? "complete" : "uncertain",
          );
        }
        const report = result.value.value;
        facts.transport =
          report.stop.kind === "exited"
            ? "settled"
            : report.stop.kind === "capture-exceeded"
              ? "failed"
              : report.stop.kind;
        facts.exitCode = report.exit.exitCode;
        const signal = hookHandlerFactsSchema.safeParse({ ...facts, signal: report.exit.signal });
        facts.signal =
          signal.success && signal.data.kind === "process" ? signal.data.signal : "UNKNOWN";
        facts.stdoutBytes = report.stdout.byteCount;
        facts.response = report.stdout.byteCount === 0 ? "missing" : "unknown";
        facts.stderrBytes = report.stderr.byteCount;
        // Neither stream is retained as diagnostics. Successful stdout supplies only its typed decision.
        facts.omittedBytes = report.stdout.byteCount + report.stderr.byteCount;
        terminated =
          report.killStage !== "unconfirmed" &&
          report.stop.kind !== "uncertain" &&
          result.receipts.every((receipt) => receipt.state === "terminated");
        if (!terminated) throw new HookExecutionError("hook-cleanup-uncertain", "uncertain");
        if (report.stop.kind !== "exited")
          throw new HookExecutionError(`hook-process-${report.stop.kind}`);
        if (report.exit.exitCode !== 0) throw new HookExecutionError("hook-process-exit");
        if (
          report.stdout.truncated ||
          report.stderr.truncated ||
          report.stderr.byteCount > HOOK_LIMITS.diagnosticBytes
        )
          throw new HookExecutionError("hook-output-exhausted");
        if (!(await input.current()) || input.context.signal.aborted)
          throw new HookExecutionError("hook-authority-stale");
        try {
          const decision = decodeHookResponse(
            report.stdout.inlineBytes,
            input.wire,
            input.registration,
          );
          facts.response = "valid";
          return decision;
        } catch {
          facts.response = "invalid";
          throw new HookExecutionError("invalid-hook-response");
        }
      };
      let outcome:
        | { ok: true; decision: Awaited<ReturnType<typeof execute>> }
        | { ok: false; error: unknown };
      try {
        outcome = { ok: true, decision: await execute() };
      } catch (error) {
        outcome = { ok: false, error };
      }
      try {
        if (terminated) {
          await chmod(directory, 0o700);
          await rm(directory, { recursive: true });
        }
      } catch {
        outcome = {
          ok: false,
          error: new HookExecutionError(
            !outcome.ok && outcome.error instanceof HookExecutionError
              ? outcome.error.code
              : "hook-cleanup-uncertain",
            "uncertain",
          ),
        };
      }
      input.context.report?.(facts);
      if (!outcome.ok) throw outcome.error;
      return outcome.decision;
    },
  };
}
