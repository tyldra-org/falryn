/** Shared Bun subprocess contracts and lifecycle helpers. */

import type {
  ManagedServiceError,
  ManagedServiceEvent,
  ManagedServiceExit,
  PtySessionEvent,
  PtySessionSnapshot,
} from "../../domain/index.ts";
import { signalOwnedTree } from "../host-process-tree.ts";

export type HostSubprocess = Bun.Subprocess;
export type HostTerminal = NonNullable<HostSubprocess["terminal"]>;

export type HostFileSink = {
  write(chunk: Uint8Array): number;
  flush(): number | Promise<number>;
  end(): number | Promise<number>;
};

export type HostReadable = {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    releaseLock(): void;
  };
};

export type ServiceStream = "stdout" | "stderr";

export function signalHostTree(
  child: HostSubprocess,
  signal: "SIGINT" | "SIGTERM" | "SIGKILL",
): void {
  if (typeof child.pid === "number") {
    signalOwnedTree(child.pid, signal);
    return;
  }
  child.kill(signal);
}

export type PtyEventDetail = {
  [Kind in PtySessionEvent["kind"]]: Omit<
    Extract<PtySessionEvent, { readonly kind: Kind }>,
    "sessionId" | "order"
  >;
}[PtySessionEvent["kind"]];
export type ManagedServiceEventDetail = {
  [Kind in ManagedServiceEvent["kind"]]: Omit<
    Extract<ManagedServiceEvent, { readonly kind: Kind }>,
    "serviceId" | "order"
  >;
}[ManagedServiceEvent["kind"]];
export type StopIntent =
  | { readonly kind: "stop"; readonly reason: "requested" | "idle" | "shutdown" }
  | {
      readonly kind: "failure";
      readonly reason: "spawn-failed" | "readiness-timeout" | "readiness-output-exceeded";
    };
export type FailureIntent = Extract<StopIntent, { readonly kind: "failure" }>;
export type RestartFailureReason = "no-restart-policy" | "restart-budget-exhausted";

export function readableStream(value: unknown): value is HostReadable {
  return typeof value === "object" && value !== null && "getReader" in value;
}

export function fileSink(value: HostSubprocess["stdin"]): HostFileSink | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("write" in value) ||
    !("flush" in value) ||
    !("end" in value)
  ) {
    return null;
  }
  return value as HostFileSink;
}

export function signalText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function evictInactive<Key, Value>(
  entries: Map<Key, Value>,
  maximum: number,
  isActive: (value: Value) => boolean,
): boolean {
  while (entries.size >= maximum) {
    const candidate = [...entries.entries()].find(([, value]) => !isActive(value));
    if (candidate === undefined) {
      return false;
    }
    entries.delete(candidate[0]);
  }
  return true;
}

export function safeHostCode(thrown: unknown): string | null {
  if (typeof thrown !== "object" || thrown === null || !("code" in thrown)) {
    return null;
  }
  const code = thrown.code;
  return typeof code === "string" && /^[A-Z]{2,16}$/.test(code) ? code : null;
}

export async function waitForExit(
  exit: Promise<ManagedServiceExit | PtySessionSnapshot["exit"]>,
  timeoutMs: number,
): Promise<ManagedServiceExit | PtySessionSnapshot["exit"] | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([exit, timeout]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

export function restartFailureReason(maxRestarts: number): RestartFailureReason {
  return maxRestarts === 0 ? "no-restart-policy" : "restart-budget-exhausted";
}

export function failureError(
  reason: Extract<StopIntent, { kind: "failure" }>["reason"],
): ManagedServiceError {
  switch (reason) {
    case "spawn-failed":
      return { kind: "managed-service", code: "spawn-failed", detail: null };
    case "readiness-timeout":
      return { kind: "managed-service", code: "readiness-timeout" };
    case "readiness-output-exceeded":
      return { kind: "managed-service", code: "readiness-output-exceeded" };
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

export class ByteReplay {
  private readonly chunks: Uint8Array[] = [];
  private retainedBytes = 0;
  private droppedBytes = 0;

  constructor(private readonly maximumBytes: number) {}

  append(data: Uint8Array): void {
    if (this.maximumBytes === 0) {
      this.droppedBytes += data.byteLength;
      return;
    }
    const bytes = new Uint8Array(data);
    if (bytes.byteLength >= this.maximumBytes) {
      this.droppedBytes += this.retainedBytes + bytes.byteLength - this.maximumBytes;
      this.chunks.length = 0;
      this.retainedBytes = 0;
      const tail = bytes.slice(bytes.byteLength - this.maximumBytes);
      this.chunks.push(tail);
      this.retainedBytes = tail.byteLength;
      return;
    }
    while (this.chunks.length > 0 && this.retainedBytes + bytes.byteLength > this.maximumBytes) {
      const first = this.chunks.shift();
      if (first === undefined) {
        break;
      }
      this.retainedBytes -= first.byteLength;
      this.droppedBytes += first.byteLength;
    }
    this.chunks.push(bytes);
    this.retainedBytes += bytes.byteLength;
  }

  snapshot(): { bytes: Uint8Array; droppedBytes: number } {
    const bytes = new Uint8Array(this.retainedBytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes, droppedBytes: this.droppedBytes };
  }
}
