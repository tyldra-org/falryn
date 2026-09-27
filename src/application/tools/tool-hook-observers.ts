import type { ProductTaskResources } from "../orchestration/product-resources.ts";

type SessionObservers = {
  pending: number;
  active: number;
  bytes: number;
  /** Each admitted observer until its final receipt is published. */
  readonly settling: Set<Promise<void>>;
  /** Cancels every observer of this session: user stop or shutdown. */
  readonly stop: AbortController;
};
/**
 * Counters bound admission; the product resource owner supplies queueing and execution.
 * Observers belong to their session, not their subject: they outlive the subject's turn and
 * settle only through {@link settleHookObservers}.
 */
const owners = new WeakMap<object, Map<string, SessionObservers>>();
export function admitHookObserver(input: {
  owner: object | undefined;
  task: ProductTaskResources | undefined;
  session: string;
  payloadBytes: number;
  run(task: ProductTaskResources, started: () => void, stop: AbortSignal): Promise<void>;
  failed(): void;
}): { start(): void; cancel(): void } | null {
  if (!input.owner || !input.task) return null;
  const sessions = owners.get(input.owner) ?? new Map();
  const current: SessionObservers = sessions.get(input.session) ?? {
    pending: 0,
    active: 0,
    bytes: 0,
    settling: new Set(),
    stop: new AbortController(),
  };
  if (current.pending >= 16 || current.bytes + input.payloadBytes > 1_048_576) return null;
  const task = input.task.subdivide({ concurrency: 4 });
  const release = task?.retain();
  if (!task || !release) {
    task?.close();
    return null;
  }
  owners.set(input.owner, sessions);
  sessions.set(input.session, current);
  current.pending++;
  current.bytes += input.payloadBytes;
  const settled = Promise.withResolvers<void>();
  current.settling.add(settled.promise);
  let state: "reserved" | "pending" | "active" | "finished" = "reserved";
  const finish = () => {
    if (state === "finished") return;
    if (state === "active") current.active--;
    else {
      current.pending--;
      current.bytes -= input.payloadBytes;
    }
    state = "finished";
    current.settling.delete(settled.promise);
    if (current.pending + current.active === 0 && sessions.get(input.session) === current)
      sessions.delete(input.session);
    task.close();
    release();
    settled.resolve();
  };
  return {
    cancel() {
      if (state === "reserved") finish();
    },
    start() {
      if (state !== "reserved") return;
      state = "pending";
      // Retention covers callback, cancellation drain and the final semantic receipt.
      void input
        .run(
          task,
          () => {
            if (state !== "pending") return;
            state = "active";
            current.pending--;
            current.bytes -= input.payloadBytes;
            current.active++;
          },
          current.stop.signal,
        )
        .catch(input.failed)
        .finally(finish);
    },
  };
}

/**
 * Settle a session's observers before its stores close, so each leaves its final receipt.
 * "drain" lets admitted observers finish inside the deadlines reserved when they were
 * admitted: a session that ends naturally still owes them. "cancel" stops them first (user
 * stop, shutdown) and waits only for their bounded cancellation. Either way nothing of the
 * session runs afterwards.
 */
export async function settleHookObservers(
  owner: object,
  session: string,
  mode: "drain" | "cancel",
): Promise<void> {
  const current = owners.get(owner)?.get(session);
  if (current === undefined) return;
  if (mode === "cancel") current.stop.abort();
  // An observer admitted while settling joins the same wait.
  while (current.settling.size > 0) await Promise.allSettled([...current.settling]);
}
