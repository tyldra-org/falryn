import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { PackageHealthHost } from "../../application/extensions/package-health.ts";
import {
  bytesDigest,
  ExtensionInputError,
  packageRelativePath,
  parseMetadata,
} from "../../domain/extensions/canonical.ts";
import {
  PACKAGE_HEALTH_LIMITS,
  type PackageHealthRecord,
  packageHealthFrameSchema,
} from "../../domain/extensions/package-health.ts";
import { duration, managedServiceId } from "../../domain/foundation/index.ts";
import { sameProcessBirth } from "../../domain/process/process-identity.ts";
import { OFFLINE_SANDBOX_NETWORK, SINGLE_PROCESS_SANDBOX } from "../../domain/security/sandbox.ts";
import { createHostProcessIdentityPort } from "../process/host-process-identity.ts";
import { createHostManagedServicePort } from "../process/host-process-sessions/managed-service.ts";
import { createHostSandbox } from "../security/host-sandbox.ts";

/** Inspect load commands as bytes. Never load a library merely to test compatibility. */
export function validateHealthExecutable(bytes: Uint8Array, arch = process.arch): string | null {
  if (bytes.byteLength < 32) return "native-format-unavailable";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.getUint32(0, true) !== 0xfeedfacf ||
    view.getUint32(12, true) !== 2 ||
    arch !== "arm64" ||
    view.getUint32(4, true) !== 0x0100000c
  )
    return "native-format-unavailable";
  const commands = view.getUint32(16, true),
    size = view.getUint32(20, true);
  if (commands > 4096 || size > bytes.byteLength - 32) return "native-header-invalid";
  let offset = 32;
  for (let i = 0; i < commands; i++) {
    if (offset + 8 > 32 + size) return "native-header-invalid";
    const command = view.getUint32(offset, true),
      length = view.getUint32(offset + 4, true);
    if (length < 8 || offset + length > 32 + size) return "native-header-invalid";
    if ([0xc, 0x20, 0x80000018, 0x8000001f, 0x80000023].includes(command)) {
      if (length < 24) return "native-header-invalid";
      const nameOffset = view.getUint32(offset + 8, true);
      if (nameOffset < 24 || nameOffset >= length) return "native-header-invalid";
      const name =
        new TextDecoder("utf-8", { fatal: true })
          .decode(bytes.subarray(offset + nameOffset, offset + length))
          .split("\0")[0] ?? "";
      // The macOS shared cache owns these runtime libraries. Package-supplied or
      // loader-relative dependencies need their own qualification before execution.
      if (name !== "/usr/lib/libSystem.B.dylib") return "native-dependency-unavailable";
      if (name.includes("..")) return "native-dependency-unavailable";
    }
    if (command === 0x8000001c) return "native-loader-path-unavailable";
    if (command === 0x27) return "native-loader-environment-unavailable";
    if (command === 0xe) {
      if (length < 12) return "native-header-invalid";
      const nameOffset = view.getUint32(offset + 8, true);
      if (length < 12 || nameOffset < 12 || nameOffset >= length) return "native-header-invalid";
      const loader = new TextDecoder()
        .decode(bytes.subarray(offset + nameOffset, offset + length))
        .split("\0")[0];
      if (loader !== "/usr/lib/dyld") return "native-loader-unavailable";
    }
    offset += length;
  }
  return offset === 32 + size ? null : "native-header-invalid";
}

export function createHostPackageHealth(options: {
  directory: string;
  policy(): { mode: string; generation: number };
}): PackageHealthHost {
  const requestedRoot = resolve(options.directory);
  const root = join(realpathSync(dirname(requestedRoot)), basename(requestedRoot));
  const identity = createHostProcessIdentityPort();
  function ownedDirectory(record: PackageHealthRecord) {
    return join(root, record.result.binding.attempt);
  }
  function cleanup(record: PackageHealthRecord): PackageHealthRecord {
    if (record.directory === null)
      return { ...record, result: { ...record.result, cleanup: "removed" } };
    if (record.directory !== ownedDirectory(record))
      return { ...record, result: { ...record.result, cleanup: "unknown" } };
    try {
      if (existsSync(record.directory)) {
        if (
          lstatSync(record.directory).isSymbolicLink() ||
          realpathSync(dirname(record.directory)) !== realpathSync(root)
        )
          throw new Error("unsafe-root");
        chmodSync(record.directory, 0o700);
        rmSync(record.directory, { recursive: true });
      }
      return { ...record, result: { ...record.result, cleanup: "removed" } };
    } catch {
      return { ...record, result: { ...record.result, cleanup: "retained" } };
    }
  }
  return {
    async run(input) {
      let record = input.record;
      let outputBytes = 0,
        frames = 0,
        requests = 0;
      const requestsMs: number[] = [];
      let startMs = 0,
        shutdownMs = 0;
      const started = performance.now();
      const stop = new AbortController();
      const deadline = AbortSignal.timeout(PACKAGE_HEALTH_LIMITS.wallTimeMs);
      const signal = AbortSignal.any([input.signal, stop.signal, deadline]);
      let reason: string | null = null;
      const save = () => {
        record = { ...record, revision: record.revision + 1 };
        input.save(record);
      };
      const directory = ownedDirectory(record);
      const policy = options.policy();
      const sandbox = createHostSandbox({
        policy: () => {
          const current = options.policy();
          return {
            generation: current.generation,
            mode: current.mode === "strict" ? "strict" : "degraded",
            authority: "user",
            boundary: {
              readRoots: [directory],
              writeRoots: [],
              network: OFFLINE_SANDBOX_NETWORK,
              processes: SINGLE_PROCESS_SANDBOX,
              lifecyclePaths: [],
            },
          };
        },
      });
      const service = createHostManagedServicePort({ sandbox });
      const id = managedServiceId.from(record.result.binding.attempt);
      let generation: Parameters<typeof service.send>[1] | null = null;
      const subscriptions: (() => void)[] = [];
      let pending: {
        id: number;
        method: string;
        resolve(): void;
        reject(error: Error): void;
      } | null = null;
      let buffered = "";
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const fail = (code: string) => {
        reason ??= code;
        pending?.reject(new ExtensionInputError(reason));
        pending = null;
        stop.abort();
      };
      const consume = (bytes: Uint8Array, stderr = false) => {
        outputBytes += bytes.byteLength;
        const declared = input.declaration.execution?.resources.maxOutputBytes ?? 0;
        if (outputBytes > Math.min(PACKAGE_HEALTH_LIMITS.outputBytes, declared))
          return fail("health-output-exhausted");
        if (stderr) return;
        try {
          buffered += decoder.decode(bytes, { stream: true });
          if (Buffer.byteLength(buffered) > PACKAGE_HEALTH_LIMITS.frameBytes)
            return fail("health-frame-exhausted");
          let newline = buffered.indexOf("\n");
          while (newline >= 0) {
            const line = buffered.slice(0, newline);
            buffered = buffered.slice(newline + 1);
            if (++frames > PACKAGE_HEALTH_LIMITS.frames)
              return fail("health-frame-count-exhausted");
            const frame = packageHealthFrameSchema.parse(parseMetadata(line));
            if (
              !pending ||
              frame.id !== pending.id ||
              frame.method !== pending.method ||
              Object.entries(record.result.binding).some(
                ([key, value]) => frame[key as keyof typeof frame] !== value,
              )
            )
              return fail("health-protocol-forgery");
            pending.resolve();
            pending = null;
            newline = buffered.indexOf("\n");
          }
        } catch {
          fail("health-protocol-malformed");
        }
      };
      const onAbort = () =>
        fail(
          input.signal.aborted
            ? "cancelled"
            : deadline.aborted
              ? "health-deadline"
              : (reason ?? "health-stopped"),
        );
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        if (policy.mode !== "strict" || sandbox.probe().status !== "available")
          throw new ExtensionInputError("health-sandbox-unavailable");
        const execution = input.declaration.execution;
        if (execution?.loader !== "native")
          throw new ExtensionInputError("health-loader-unavailable");
        const executable = input.snapshot.files.find((file) => file.path === execution.executable);
        if (!executable) throw new ExtensionInputError("health-executable-missing");
        const invalid = validateHealthExecutable(executable.bytes);
        if (invalid) throw new ExtensionInputError(invalid);
        if (!existsSync(root)) mkdirSync(root, { mode: 0o700 });
        if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
          throw new ExtensionInputError("health-root-unavailable");
        record = { ...record, directory };
        save();
        mkdirSync(directory, { mode: 0o700 });
        for (const file of input.snapshot.files) {
          if (signal.aborted) throw new ExtensionInputError("cancelled");
          if (packageRelativePath(file.path) !== file.path)
            throw new ExtensionInputError("invalid-package-path");
          const target = join(directory, file.path);
          mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
          writeFileSync(target, file.bytes, {
            flag: "wx",
            mode: file.path === execution.executable ? 0o500 : 0o400,
          });
          if (bytesDigest(readFileSync(target)) !== bytesDigest(file.bytes))
            throw new ExtensionInputError("health-materialization-changed");
        }
        const cwd = execution.cwd === undefined ? directory : join(directory, execution.cwd);
        if (!lstatSync(cwd).isDirectory() || realpathSync(cwd) !== cwd)
          throw new ExtensionInputError("health-cwd-unavailable");
        chmodSync(directory, 0o500);
        if (!(await input.current()) || signal.aborted)
          throw new ExtensionInputError("stale-health-authority");
        await sandbox.run(
          {
            invocationId: record.operation,
            capabilityId: record.result.binding.contribution,
            source: "extension",
            catalogGeneration: input.catalogGeneration,
            policyGeneration: policy.generation,
            inputFingerprint: record.fingerprint,
            effect: "observation",
            confirmationId: input.confirmation,
            resourceTaskId: input.resourceTaskId,
            expiresAt: input.expiresAt,
          },
          async () => {
            const launched = await service.start({
              serviceId: id,
              protocol: record.result.binding.protocol,
              executable: join(directory, execution.executable),
              argv: execution.argv,
              environment: {},
              cwd,
              readiness: { kind: "immediate" },
              idle: { kind: "disabled" },
              restart: { maxRestarts: 0, windowMs: duration(60_000) },
              shutdownTimeoutMs: duration(
                Math.min(execution.resources.shutdownMs, PACKAGE_HEALTH_LIMITS.shutdownMs),
              ),
              replayBytes: PACKAGE_HEALTH_LIMITS.outputBytes,
            });
            if (!launched.ok) throw new ExtensionInputError("health-start-failed");
            generation = launched.value.generation;
            const pid = launched.value.pid;
            record = {
              ...record,
              result: {
                ...record.result,
                state: "running",
                code: "health-running",
                pid,
                sandbox: launched.value.sandbox ?? null,
              },
            };
            if (pid !== null) {
              const birth = await identity.inspect(pid);
              if (birth.kind === "present") record = { ...record, birth: birth.identity };
            }
            save();
            if (!record.birth) throw new ExtensionInputError("health-birth-unavailable");
            const attached = service.attach(id, (event) => {
              if (event.kind === "output") consume(event.bytes, event.stream === "stderr");
              else if (event.kind === "crashed" || event.kind === "failed")
                fail("health-child-crashed");
            });
            if (!attached.ok) throw new ExtensionInputError("health-transport-unavailable");
            subscriptions.push(attached.value.detach);
            consume(attached.value.replay.stdout);
            consume(attached.value.replay.stderr, true);
            const methods = ["initialize", "health", "health", "shutdown"] as const;
            for (const [index, method] of methods.entries()) {
              if (signal.aborted) throw new ExtensionInputError(reason ?? "cancelled");
              if (!(await input.current())) throw new ExtensionInputError("stale-health-authority");
              const requestStart = performance.now();
              const wait = Promise.withResolvers<void>();
              pending = {
                id: index + 1,
                method,
                resolve: () => wait.resolve(),
                reject: wait.reject,
              };
              const timeout = setTimeout(
                () => fail("health-request-timeout"),
                Math.min(
                  index === 0 ? execution.resources.startupMs : execution.resources.requestMs,
                  PACKAGE_HEALTH_LIMITS.requestMs,
                ),
              );
              const reply = wait.promise;
              // Attach the rejection handler before any async transport operation.
              const sent = service.send(
                id,
                launched.value.generation,
                new TextEncoder().encode(
                  `${JSON.stringify({ ...record.result.binding, id: index + 1, method })}\n`,
                ),
              );
              try {
                await Promise.all([
                  reply,
                  sent.then((result) => {
                    if (!result.ok) fail("health-write-failed");
                  }),
                ]);
                requests++;
                requestsMs.push(performance.now() - requestStart);
                if (index === 0) startMs = performance.now() - started;
              } finally {
                clearTimeout(timeout);
                pending = null;
              }
            }
            if (buffered.length !== 0) throw new ExtensionInputError("health-protocol-truncated");
          },
        );
      } catch (error) {
        reason ??= input.signal.aborted
          ? "cancelled"
          : deadline.aborted
            ? "health-deadline"
            : error instanceof ExtensionInputError
              ? error.code
              : "health-host-failed";
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
      const shutdownStart = performance.now();
      let terminated = generation === null;
      if (generation !== null) {
        try {
          const stopped = await service.stop(id, generation);
          terminated = stopped.ok;
        } catch {
          terminated = false;
        }
      }
      for (const detach of subscriptions) detach();
      try {
        buffered += decoder.decode();
        if (buffered.length) reason ??= "health-protocol-truncated";
      } catch {
        reason ??= "health-protocol-truncated";
      }
      shutdownMs = performance.now() - shutdownStart;
      const sandboxReceipt = service.snapshot(id)?.sandbox ?? record.result.sandbox;
      record = {
        ...record,
        result: {
          ...record.result,
          state: terminated
            ? reason === null && requests === 4
              ? "healthy"
              : "failed"
            : "uncertain",
          code: !terminated ? "health-cleanup-uncertain" : (reason ?? "health-completed"),
          terminated,
          requests,
          outputBytes,
          sandbox: sandboxReceipt,
          resources: {
            ...record.result.resources,
            containment:
              sandboxReceipt?.effectiveMode === "strict"
                ? "filesystem-network-single-process"
                : "unavailable",
          },
          timings: { startMs, requestsMs, shutdownMs },
        },
      };
      if (terminated) record = cleanup(record);
      if (record.result.cleanup === "retained" && record.result.state === "healthy")
        record = {
          ...record,
          result: { ...record.result, state: "failed", code: "health-files-retained" },
        };
      try {
        save();
      } catch {
        return {
          ...record,
          result: { ...record.result, state: "uncertain", code: "health-persistence-uncertain" },
        };
      }
      return record;
    },
    async recover(record, signal) {
      let terminated = record.result.terminated;
      if (!terminated && record.birth && !signal.aborted) {
        const current = await identity.inspect(record.birth.pid);
        if (
          current.kind === "vanished" ||
          (current.kind === "present" && !sameProcessBirth(current.identity, record.birth))
        )
          terminated = true;
        else if (current.kind === "present") {
          try {
            process.kill(record.birth.pid, "SIGKILL");
            const deadline = Date.now() + 1000;
            while (Date.now() < deadline && !signal.aborted) {
              const next = await identity.inspect(record.birth.pid);
              if (
                next.kind === "vanished" ||
                (next.kind === "present" && !sameProcessBirth(next.identity, record.birth))
              ) {
                terminated = true;
                break;
              }
              await Bun.sleep(20);
            }
          } catch {
            /* No termination claim without a subsequent identity observation. */
          }
        }
      }
      let next: PackageHealthRecord = {
        ...record,
        revision: record.revision + 1,
        result: {
          ...record.result,
          terminated,
          state: terminated ? "recovered" : "uncertain",
          code: terminated ? "health-recovered" : "health-recovery-unknown",
        },
      };
      if (terminated) next = cleanup(next);
      if (terminated && next.result.cleanup !== "removed")
        next = {
          ...next,
          result: {
            ...next.result,
            state: "failed",
            code:
              next.result.cleanup === "retained" ? "health-files-retained" : "health-files-unknown",
          },
        };
      return next;
    },
  };
}
