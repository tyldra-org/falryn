/**
 * The React seam over `render-schedule`.
 *
 * The schedule is a pure decision. This module is the one place a clock is
 * asked to wait, and the one place a held snapshot is told to become state.
 * Callers fold immediately into a ref and publish when `note` returns true or
 * when `onDue` fires — they never set a second timer of their own.
 *
 * Without a provider, `note` always publishes. Frame tests that mount a static
 * tree must not wait on cadence, and a missing clock is not a reason to drop
 * an update.
 */

import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef } from "react";
import type { ClockPort, DurationMs, Instant } from "../../domain/index.ts";
import {
  dueRender,
  IDLE_RENDER_SCHEDULE,
  noteRender,
  type RenderKind,
  type RenderSchedule,
  STREAM_PUBLISH_CADENCE,
} from "../render-schedule.ts";

export type RenderGate = {
  /** Record an update. `true` means publish the held snapshot now. */
  note(kind: RenderKind): boolean;
  /** Fires when a held stream snapshot becomes due. */
  onDue(listener: () => void): () => void;
};

export const IMMEDIATE_GATE: RenderGate = {
  note: () => true,
  onDue: () => () => {},
};

const RenderGateContext = createContext<RenderGate | null>(null);

export function useRenderGate(): RenderGate {
  return useContext(RenderGateContext) ?? IMMEDIATE_GATE;
}

export function RenderGateProvider(props: {
  readonly clock: ClockPort;
  readonly cadence?: DurationMs;
  readonly children: ReactNode;
}): ReactNode {
  const clockRef = useRef(props.clock);
  clockRef.current = props.clock;
  const cadence = props.cadence ?? STREAM_PUBLISH_CADENCE;
  const scheduleRef = useRef<RenderSchedule>(IDLE_RENDER_SCHEDULE);
  const listenersRef = useRef(new Set<() => void>());
  const waitingRef = useRef<AbortController | null>(null);

  const gate = useMemo<RenderGate>(() => {
    const stopWait = (): void => {
      waitingRef.current?.abort();
      waitingRef.current = null;
    };

    const notify = (): void => {
      for (const listener of listenersRef.current) {
        listener();
      }
    };

    const startWait = (dueAt: Instant): void => {
      if (waitingRef.current !== null) {
        return;
      }
      const controller = new AbortController();
      waitingRef.current = controller;
      void clockRef.current.waitUntil(dueAt, controller.signal).then((outcome) => {
        if (waitingRef.current !== controller) {
          return;
        }
        waitingRef.current = null;
        if (outcome !== "reached") {
          return;
        }
        const decision = dueRender(scheduleRef.current, clockRef.current.now());
        scheduleRef.current = decision.schedule;
        if (decision.publish) {
          notify();
        }
      });
    };

    return {
      note(kind: RenderKind): boolean {
        const decision = noteRender(scheduleRef.current, kind, clockRef.current.now(), cadence);
        scheduleRef.current = decision.schedule;
        if (decision.publish) {
          stopWait();
          notify();
          return true;
        }
        if (decision.schedule.dueAt !== null) {
          startWait(decision.schedule.dueAt);
        }
        return false;
      },
      onDue(listener: () => void): () => void {
        listenersRef.current.add(listener);
        return () => {
          listenersRef.current.delete(listener);
        };
      },
    };
  }, [cadence]);

  useEffect(() => {
    return () => {
      waitingRef.current?.abort();
      waitingRef.current = null;
    };
  }, []);

  return <RenderGateContext.Provider value={gate}>{props.children}</RenderGateContext.Provider>;
}
