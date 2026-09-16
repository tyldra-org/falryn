import type { ProductTaskResources } from "../orchestration/product-resources.ts";

/** Counters bound admission; the product resource owner supplies queueing and execution. */
const owners = new WeakMap<
  object,
  Map<string, { pending: number; active: number; bytes: number }>
>();
export function admitHookObserver(input: {
  owner: object | undefined;
  task: ProductTaskResources | undefined;
  session: string;
  payloadBytes: number;
  run(task: ProductTaskResources, started: () => void): Promise<void>;
  failed(): void;
}): { start(): void; cancel(): void } | null {
  if (!input.owner || !input.task) return null;
  const sessions = owners.get(input.owner) ?? new Map();
  const current = sessions.get(input.session) ?? { pending: 0, active: 0, bytes: 0 };
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
  let state: "reserved" | "pending" | "active" | "finished" = "reserved";
  const finish = () => {
    if (state === "finished") return;
    if (state === "active") current.active--;
    else {
      current.pending--;
      current.bytes -= input.payloadBytes;
    }
    state = "finished";
    if (current.pending + current.active === 0) sessions.delete(input.session);
    task.close();
    release();
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
        .run(task, () => {
          if (state !== "pending") return;
          state = "active";
          current.pending--;
          current.bytes -= input.payloadBytes;
          current.active++;
        })
        .catch(input.failed)
        .finally(finish);
    },
  };
}
