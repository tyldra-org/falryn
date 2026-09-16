import { AsyncLocalStorage } from "node:async_hooks";
import type { EnvironmentBinding } from "../../application/configuration/scoped-environment.ts";
import type { EnvironmentMap } from "../../domain/process/environment.ts";
import { environmentError, forbiddenEnvironmentName } from "../../domain/process/environment.ts";
import type {
  CommandRunnerPort,
  ManagedServicePort,
  ProcessCapturePort,
  PtySessionPort,
} from "../../domain/process/index.ts";

/** A turn's async descendants share its binding; sibling sessions own separate contexts. */
export function createEnvironmentProcessContext() {
  const local = new AsyncLocalStorage<{ binding: EnvironmentBinding | null }>();
  let capture: (() => EnvironmentBinding | null) | null = null;
  const retained = new Map<string, { generation: string; running(): boolean; exists(): boolean }>();
  const prune = () => {
    for (const [id, entry] of retained) if (!entry.exists()) retained.delete(id);
  };
  const selected = () => {
    const pinned = local.getStore();
    return pinned === undefined ? (capture?.() ?? null) : pinned.binding;
  };
  const child = async (operation: EnvironmentMap, accepts?: (name: string) => boolean) => {
    // Unconfigured library compositions retain their explicit port contract.
    if (!capture) return operation;
    return selected()?.child(operation, accepts) ?? null;
  };
  const owned = async (values: EnvironmentMap, accepts?: (name: string) => boolean) => {
    const scoped = await child({}, accepts);
    if (scoped === null || Object.keys(values).some(forbiddenEnvironmentName)) return null;
    const combined = { ...scoped, ...values };
    return environmentError(combined, process.platform === "win32") ? null : combined;
  };
  return {
    install(next: () => EnvironmentBinding | null) {
      capture = next;
    },
    scope() {
      const binding = local.getStore() ?? { binding: selected() };
      return <T>(work: () => Promise<T>): Promise<T> => local.run(binding, work);
    },
    restartRequired() {
      prune();
      const generation = capture?.()?.generation;
      return [...retained]
        .filter(([, entry]) => entry.generation !== generation && entry.running())
        .map(([id]) => id);
    },
    async gitExecutable(signal: AbortSignal) {
      if (signal.aborted) return null;
      if (!capture) return "/usr/bin/git";
      const environment = await child({});
      if (environment === null) return null;
      const path = environment.PATH;
      return path === undefined ? "/usr/bin/git" : Bun.which("git", { PATH: path });
    },
    gitCapture(port: ProcessCapturePort): ProcessCapturePort {
      return {
        ...port,
        async run(request, listener) {
          const environment = await owned(
            request.environment,
            (name) => name === "PATH" || name === "LANG" || name.startsWith("LC_"),
          );
          return environment === null
            ? {
                ok: false,
                error: {
                  kind: "process-capture",
                  code: "spawn-failed",
                  detail: "scoped-environment-unavailable",
                },
              }
            : port.run({ ...request, environment }, listener);
        },
      };
    },
    commands(port: CommandRunnerPort): CommandRunnerPort {
      return {
        async run(request) {
          const environment = await child(request.environment);
          return environment === null
            ? { kind: "spawn-failed", code: "scoped-environment-unavailable" }
            : port.run({ ...request, environment });
        },
      };
    },
    capture(port: ProcessCapturePort, accepts?: (name: string) => boolean): ProcessCapturePort {
      return {
        ...port,
        async run(request, listener) {
          const environment = await child(request.environment, accepts);
          return environment === null
            ? {
                ok: false,
                error: {
                  kind: "process-capture",
                  code: "spawn-failed",
                  detail: "scoped-environment-unavailable",
                },
              }
            : port.run({ ...request, environment }, listener);
        },
      };
    },
    services(port: ManagedServicePort): ManagedServicePort {
      return {
        ...port,
        async start(request) {
          prune();
          const binding = selected();
          const previous = retained.get(`service:${request.serviceId}`);
          const environment = await owned(request.environment);
          if (environment === null)
            return {
              ok: false,
              error: {
                kind: "managed-service",
                code: "spawn-failed",
                detail: "scoped-environment-unavailable",
              },
            };
          const result = await port.start({
            ...request,
            environment,
            authorizeLaunch: async (signal) =>
              (!request.authorizeLaunch || (await request.authorizeLaunch(signal))) &&
              (!binding || (await binding.child({}, undefined, signal)) !== null),
          });
          if (result.ok && binding)
            retained.set(`service:${result.value.serviceId}`, {
              generation: previous?.generation ?? binding.generation,
              exists: () => port.snapshot(result.value.serviceId) !== null,
              running: () => {
                const value = port.snapshot(result.value.serviceId);
                return value !== null && !["stopped", "failed"].includes(value.state);
              },
            });
          return result;
        },
      };
    },
    pty(port: PtySessionPort): PtySessionPort {
      return {
        ...port,
        async open(request) {
          prune();
          const binding = selected();
          const environment = await owned(request.environment);
          if (environment === null)
            return {
              ok: false,
              error: {
                kind: "pty",
                code: "spawn-failed",
                detail: "scoped-environment-unavailable",
              },
            };
          const result = await port.open({ ...request, environment });
          if (result.ok && binding)
            retained.set(`pty:${result.value.sessionId}`, {
              generation: binding.generation,
              exists: () => port.snapshot(result.value.sessionId) !== null,
              running: () => {
                const value = port.snapshot(result.value.sessionId);
                return value !== null && !["exited", "failed"].includes(value.state);
              },
            });
          return result;
        },
      };
    },
  };
}
export type EnvironmentProcessContext = ReturnType<typeof createEnvironmentProcessContext>;
