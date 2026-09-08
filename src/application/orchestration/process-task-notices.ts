/** Bounded notify-only projection of already committed terminal task events. */
import { sequence, streamId } from "../../domain/foundation/index.ts";
import type { EventStorePort, RuntimeEvent } from "../../domain/sessions/index.ts";
import type { ProcessTaskNotification } from "./process-task-supervisor.ts";

export function createProcessTaskNotices(events: EventStorePort) {
  const notices = new Map<string, RuntimeEvent>();
  const listeners = new Set<() => void>();
  return {
    events: () => [...notices.values()],
    subscribe(listener: () => void): () => void {
      if (listeners.size >= 64) throw new Error("process-task-notice-capacity");
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async notify(notice: ProcessTaskNotification, signal: AbortSignal): Promise<boolean> {
      if (notices.has(notice.wake.notificationId)) return true;
      if (signal.aborted || notices.size >= 256) return false;
      const eventId = notice.wake.terminalEventId;
      const separator = eventId.lastIndexOf(":");
      const read = await events.readFrom(
        {
          streamId: streamId.from(eventId.slice(0, separator)),
          afterSequence: sequence.from(notice.task.revision - 1),
        },
        1,
        signal,
      );
      if (!read.ok) return false;
      const event = read.value[0];
      if (
        signal.aborted ||
        event?.eventId !== eventId ||
        event.kind !== "process.task.changed" ||
        event.payload.task.state !== "terminal"
      )
        return false;
      notices.set(notice.wake.notificationId, event);
      for (const listener of listeners) listener();
      return true;
    },
    dispose() {
      listeners.clear();
      notices.clear();
    },
  };
}
export type ProcessTaskNotices = ReturnType<typeof createProcessTaskNotices>;
