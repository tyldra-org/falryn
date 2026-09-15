/** Session ownership over the shared process supervisor; does not stop sibling services. */
import type { ManagedServicePort, ManagedServiceSnapshot } from "../../domain/process/index.ts";
export function sessionManagedServices(shared: ManagedServicePort) {
  const owned = new Map<ManagedServiceSnapshot["serviceId"], ManagedServiceSnapshot>();
  const detach = new Set<() => void>();
  let closed = false;
  const port: ManagedServicePort = {
    ...shared,
    async start(request) {
      if (closed) return { ok: false, error: { kind: "managed-service", code: "not-found" } };
      const result = await shared.start(request);
      if (result.ok) {
        owned.set(result.value.serviceId, result.value);
        if (closed) await shared.stop(result.value.serviceId, result.value.generation, "shutdown");
      }
      return result;
    },
    attach(id, listener) {
      const result = shared.attach(id, (event) => {
        if (!closed) listener(event);
      });
      if (!result.ok) return result;
      const remove = () => {
        result.value.detach();
        detach.delete(remove);
      };
      detach.add(remove);
      return { ok: true, value: { replay: result.value.replay, detach: remove } };
    },
  };
  return {
    port,
    async close() {
      closed = true;
      for (const remove of detach) remove();
      await Promise.allSettled(
        [...owned.keys()].map(async (id) => {
          const current = shared.snapshot(id);
          if (current) await shared.stop(id, current.generation, "shutdown");
        }),
      );
      owned.clear();
    },
  };
}
