/** Bun interactive PTY session adapter. */

import type { PtySessionId } from "../../domain/identity.ts";
import {
  DEFAULT_PTY_TERMINAL_NAME,
  invalidPtyRequest,
  MAX_PTY_BACKLOG_BYTES,
  MAX_PTY_SESSIONS,
  MAX_PTY_WRITE_BYTES,
  MAX_RETAINED_PTY_SESSIONS,
  PTY_TERMINATION_TIMEOUT_MS,
  type PtyAttachment,
  type PtyDimensions,
  type PtySessionError,
  type PtySessionEvent,
  type PtySessionListener,
  type PtySessionPort,
  type PtySessionRequest,
  type PtySessionSnapshot,
  type PtySignal,
  type PtySignalReport,
  type PtyTerminationReport,
  type PtyWriteReport,
  ptyDimensions,
  ptySessionId,
  validatePtySessionRequest,
} from "../../domain/index.ts";
import { err, ok, type Result } from "../../domain/result.ts";
import type { OwnedProcessRegistry } from "../host-owned-process-registry.ts";
import {
  ByteReplay,
  evictInactive,
  type HostSubprocess,
  type HostTerminal,
  type PtyEventDetail,
  safeHostCode,
  signalHostTree,
  signalText,
  waitForExit,
} from "./shared.ts";

export type HostPtySessionPortOptions = {
  readonly ownedProcesses?: OwnedProcessRegistry;
};

export function createHostPtySessionPort(options: HostPtySessionPortOptions = {}): PtySessionPort {
  const ownedProcesses = options.ownedProcesses;
  const sessions = new Map<PtySessionId, HostPtySession>();
  let nextId = 1;

  return {
    open: async (
      request: PtySessionRequest,
    ): Promise<Result<PtySessionSnapshot, PtySessionError>> => {
      const invalid = validatePtySessionRequest(request);
      if (invalid !== null) {
        return invalidPtyRequest(invalid);
      }
      const active = [...sessions.values()].filter((session) => session.isRunning()).length;
      if (active >= MAX_PTY_SESSIONS) {
        return err({ kind: "pty", code: "capacity-exceeded", maximum: MAX_PTY_SESSIONS });
      }
      if (!evictInactive(sessions, MAX_RETAINED_PTY_SESSIONS, (session) => session.isRunning())) {
        return err({
          kind: "pty",
          code: "capacity-exceeded",
          maximum: MAX_RETAINED_PTY_SESSIONS,
        });
      }

      const sessionId = ptySessionId.from(`pty-${nextId}`);
      nextId += 1;
      const session = new HostPtySession(sessionId, request);
      try {
        const child = Bun.spawn([request.executable, ...request.argv], {
          ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
          env: request.environment,
          terminal: {
            cols: request.dimensions.columns,
            rows: request.dimensions.rows,
            name: request.terminalName ?? DEFAULT_PTY_TERMINAL_NAME,
            data: (_terminal, data) => session.onData(data),
            exit: () => session.onEof(),
          },
        });
        const terminal = child.terminal;
        if (terminal === undefined) {
          signalHostTree(child, "SIGKILL");
          return err({ kind: "pty", code: "unsupported" });
        }
        session.attachProcess(child, terminal);
        if (typeof child.pid === "number") {
          ownedProcesses?.adopt(child.pid, child.exited);
        }
        sessions.set(sessionId, session);
        session.announceOpened();
        void session.watchExit();
        return ok(session.snapshot());
      } catch (thrown) {
        return err({ kind: "pty", code: "spawn-failed", detail: safeHostCode(thrown) });
      }
    },

    attach(
      sessionId: PtySessionId,
      listener: PtySessionListener,
    ): Result<PtyAttachment, PtySessionError> {
      return sessions.get(sessionId)?.attach(listener) ?? err({ kind: "pty", code: "not-found" });
    },

    write(sessionId: PtySessionId, bytes: Uint8Array): Result<PtyWriteReport, PtySessionError> {
      return sessions.get(sessionId)?.write(bytes) ?? err({ kind: "pty", code: "not-found" });
    },

    resize(
      sessionId: PtySessionId,
      dimensions: PtyDimensions,
    ): Result<PtyDimensions, PtySessionError> {
      return sessions.get(sessionId)?.resize(dimensions) ?? err({ kind: "pty", code: "not-found" });
    },

    interrupt(sessionId: PtySessionId): Result<PtySignalReport, PtySessionError> {
      return sessions.get(sessionId)?.signal("SIGINT") ?? err({ kind: "pty", code: "not-found" });
    },

    async terminate(
      sessionId: PtySessionId,
      signal: PtySignal = "SIGTERM",
    ): Promise<Result<PtyTerminationReport, PtySessionError>> {
      return (
        (await sessions.get(sessionId)?.terminate(signal)) ??
        err({ kind: "pty", code: "not-found" })
      );
    },

    snapshot(sessionId: PtySessionId): PtySessionSnapshot | null {
      return sessions.get(sessionId)?.snapshot() ?? null;
    },
  };
}

class HostPtySession {
  private child: HostSubprocess | null = null;
  private terminal: HostTerminal | null = null;
  private readonly listeners = new Set<PtySessionListener>();
  private readonly backlog: ByteReplay;
  private readonly request: PtySessionRequest;
  private dimensions: PtyDimensions;
  private state: PtySessionSnapshot["state"] = "running";
  private exit: PtySessionSnapshot["exit"] = null;
  private order = 0;
  private opened = false;
  private eof = false;
  private pendingData: Uint8Array[] = [];
  private exitPromise: Promise<PtySessionSnapshot["exit"]> | null = null;

  constructor(
    private readonly sessionId: PtySessionId,
    request: PtySessionRequest,
  ) {
    this.request = request;
    this.dimensions = request.dimensions;
    this.backlog = new ByteReplay(request.backlogBytes ?? MAX_PTY_BACKLOG_BYTES);
  }

  attachProcess(child: HostSubprocess, terminal: HostTerminal): void {
    this.child = child;
    this.terminal = terminal;
  }

  announceOpened(): void {
    this.opened = true;
    this.emit({
      kind: "opened",
      pid: this.child?.pid ?? -1,
      dimensions: this.dimensions,
      terminalName: this.request.terminalName ?? DEFAULT_PTY_TERMINAL_NAME,
      encoding: this.request.encoding ?? "utf-8",
    });
    const pending = this.pendingData;
    this.pendingData = [];
    for (const bytes of pending) {
      this.emit({ kind: "data", bytes });
    }
  }

  onData(data: Uint8Array): void {
    const bytes = new Uint8Array(data);
    this.backlog.append(bytes);
    if (!this.opened) {
      this.pendingData.push(bytes);
      return;
    }
    this.emit({ kind: "data", bytes });
  }

  onEof(): void {
    if (this.eof) {
      return;
    }
    this.eof = true;
    this.emit({ kind: "eof" });
  }

  async watchExit(): Promise<void> {
    const child = this.child;
    if (child === null) {
      return;
    }
    this.exitPromise = child.exited.then((exitCode) => {
      const exit = {
        exitCode,
        signal: signalText(child.signalCode),
      };
      this.exit = exit;
      if (this.state !== "exited") {
        this.state = "exited";
      }
      this.closeTerminal();
      this.emit({ kind: "exited", exit });
      return exit;
    });
    await this.exitPromise;
  }

  isRunning(): boolean {
    return this.state !== "exited";
  }

  attach(listener: PtySessionListener): Result<PtyAttachment, PtySessionError> {
    this.listeners.add(listener);
    this.emit({ kind: "attached" });
    let detached = false;
    return ok({
      replay: this.backlog.snapshot(),
      detach: (): void => {
        if (detached) {
          return;
        }
        detached = true;
        this.emit({ kind: "detached" });
        this.listeners.delete(listener);
      },
    });
  }

  write(bytes: Uint8Array): Result<PtyWriteReport, PtySessionError> {
    if (bytes.byteLength > MAX_PTY_WRITE_BYTES) {
      return err({ kind: "pty", code: "input-too-large", maxBytes: MAX_PTY_WRITE_BYTES });
    }
    if (this.state !== "running") {
      return err({ kind: "pty", code: "not-running", state: this.state });
    }
    const terminal = this.terminal;
    if (terminal === null || terminal.closed) {
      return ok({ status: "closed", acceptedBytes: 0 });
    }
    try {
      const acceptedBytes = terminal.write(bytes);
      return ok({
        status: acceptedBytes === bytes.byteLength ? "accepted" : "closed",
        acceptedBytes,
      });
    } catch (thrown) {
      return err({ kind: "pty", code: "write-failed", detail: safeHostCode(thrown) });
    }
  }

  resize(dimensions: PtyDimensions): Result<PtyDimensions, PtySessionError> {
    if (this.state !== "running") {
      return err({ kind: "pty", code: "not-running", state: this.state });
    }
    const valid = ptyDimensions(dimensions.columns, dimensions.rows);
    if (!valid.ok) {
      return valid;
    }
    const terminal = this.terminal;
    if (terminal === null || terminal.closed) {
      return err({ kind: "pty", code: "resize-failed", detail: "closed" });
    }
    try {
      terminal.resize(dimensions.columns, dimensions.rows);
      this.dimensions = dimensions;
      this.emit({ kind: "resized", dimensions });
      return ok(dimensions);
    } catch (thrown) {
      return err({ kind: "pty", code: "resize-failed", detail: safeHostCode(thrown) });
    }
  }

  signal(signal: PtySignal): Result<PtySignalReport, PtySessionError> {
    if (this.state !== "running") {
      return err({ kind: "pty", code: "not-running", state: this.state });
    }
    const child = this.child;
    if (child === null) {
      return err({ kind: "pty", code: "spawn-failed", detail: "missing-child" });
    }
    try {
      signalHostTree(child, signal);
      this.emit({ kind: "interrupted", signal: "SIGINT" });
      return ok({ signal, state: this.state });
    } catch (thrown) {
      return err({ kind: "pty", code: "write-failed", detail: safeHostCode(thrown) });
    }
  }

  async terminate(signal: PtySignal): Promise<Result<PtyTerminationReport, PtySessionError>> {
    if (this.state === "exited") {
      return ok({ kind: "already-exited", exit: this.exit ?? { exitCode: null, signal: null } });
    }
    if (this.state === "uncertain") {
      return ok({ kind: "uncertain", signal, exit: this.exit });
    }
    const child = this.child;
    const exitPromise = this.exitPromise;
    if (child === null || exitPromise === null) {
      return err({ kind: "pty", code: "spawn-failed", detail: "missing-child" });
    }
    try {
      signalHostTree(child, signal);
      this.emit({ kind: "termination-requested", signal });
    } catch (thrown) {
      return err({ kind: "pty", code: "write-failed", detail: safeHostCode(thrown) });
    }
    const firstExit = await waitForExit(exitPromise, PTY_TERMINATION_TIMEOUT_MS);
    if (firstExit !== null) {
      this.closeTerminal();
      return ok({ kind: "terminated", signal, exit: firstExit });
    }
    try {
      signalHostTree(child, "SIGKILL");
    } catch {
      this.state = "uncertain";
      this.closeTerminal();
      return ok({ kind: "uncertain", signal, exit: this.exit });
    }
    const finalExit = await waitForExit(exitPromise, PTY_TERMINATION_TIMEOUT_MS);
    if (finalExit === null) {
      this.state = "uncertain";
      this.closeTerminal();
      return ok({ kind: "uncertain", signal, exit: this.exit });
    }
    this.closeTerminal();
    return ok({ kind: "terminated", signal, exit: finalExit });
  }

  snapshot(): PtySessionSnapshot {
    return {
      sessionId: this.sessionId,
      pid: this.child?.pid ?? -1,
      state: this.state,
      dimensions: this.dimensions,
      terminalName: this.request.terminalName ?? DEFAULT_PTY_TERMINAL_NAME,
      encoding: this.request.encoding ?? "utf-8",
      replay: this.backlog.snapshot(),
      exit: this.exit,
    };
  }

  private closeTerminal(): void {
    try {
      this.terminal?.close();
    } catch {
      // The process result is the source of truth; closing an already-closed PTY
      // is a best-effort resource release.
    }
  }

  private emit(detail: PtyEventDetail): void {
    const event = {
      sessionId: this.sessionId,
      order: this.order + 1,
      ...detail,
    } as PtySessionEvent;
    this.order += 1;
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A consumer cannot be allowed to break Bun's PTY callback.
      }
    }
  }
}
