import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { type ClockPort, instant } from "../../domain/foundation/clock.ts";
import { err, ok } from "../../domain/foundation/result.ts";
import type {
  ProcessTaskHandle,
  ProcessTaskSnapshot,
} from "../../domain/orchestration/process-task.ts";
import { processTaskHandleSchema } from "../../domain/orchestration/process-task.ts";
import type { ProcessTaskStore } from "../../domain/orchestration/process-task-store.ts";
import {
  type QuestionAnswer,
  type QuestionInput,
  type QuestionOwner,
  type QuestionRecord,
  type QuestionResult,
  type QuestionSettlement,
  type QuestionStore,
  questionAnswerSchema,
  questionDto,
  questionInputSchema,
  questionOwnerSchema,
  validQuestionAnswer,
} from "../../domain/orchestration/question.ts";
import { conflictKey, NO_RETRY, workUnitId } from "../../domain/orchestration/work.ts";
import type { ProcessTaskNotification } from "./process-task-supervisor.ts";
import type { ProductTaskResources } from "./product-resources.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const key = (handle: ProcessTaskHandle) => JSON.stringify([handle.taskId, handle.generation]);
const matches = (credential: unknown, expected: string) =>
  typeof credential === "string" &&
  credential.length === 43 &&
  timingSafeEqual(Buffer.from(hash(credential), "hex"), Buffer.from(expected, "hex"));
type Waiter = { resolve(value: QuestionResult<QuestionSettlement>): void; dispose(): void };
const samePresenter = (
  left: QuestionInput["presenter"] | undefined,
  right: QuestionInput["presenter"],
) =>
  left?.actorId === right.actorId &&
  left.channel === right.channel &&
  left.bindingId === right.bindingId;

/** Host-only application service. Neither capability tokens nor owner factories are model tools. */
export function createStructuredQuestions(options: {
  store: QuestionStore;
  tasks: ProcessTaskStore;
  clock: ClockPort;
  deliver(task: ProcessTaskSnapshot): Promise<void>;
}) {
  const { store, tasks, clock } = options;
  const timers = new Map<string, AbortController>();
  const waiters = new Map<string, Waiter>();
  const ownerSubscriptions = new Map<string, () => void>();
  let closed = false;
  let recoveryFailed = false;
  const now = () => Number(clock.now());
  function authorized(
    handle: ProcessTaskHandle,
    credential: unknown,
    role: "owner" | "presenter",
    principal?: QuestionInput["presenter"],
  ): QuestionResult<QuestionRecord> {
    if (closed) return err({ code: "unavailable" });
    if (!processTaskHandleSchema.safeParse(handle).success) return err({ code: "denied" });
    const record = store.get(handle);
    if (
      !record.ok ||
      !matches(credential, role === "owner" ? record.value.ownerKey : record.value.presenterKey)
    )
      return err({ code: "denied" });
    if (role === "presenter" && !samePresenter(principal, record.value.input.presenter))
      return err({ code: "denied" });
    return record;
  }
  function settle(
    record: QuestionRecord,
    kind: QuestionSettlement["kind"],
    digest: string,
    answer: QuestionAnswer | null = null,
  ): QuestionRecord {
    const retained =
      kind === "answered" &&
      record.input.retention === "answer" &&
      record.input.sensitivity === "normal";
    return {
      ...record,
      revision: record.revision + 1,
      state: kind,
      settlement: {
        id: `answer:${hash(record.input.handle)}`,
        kind,
        at: now(),
        digest,
        answer: retained ? answer : null,
        retained,
        effectAuthority: false,
      },
    };
  }
  async function notifyOwner(record: QuestionRecord) {
    if (record.settlement === null) return;
    const identity = key(record.input.handle);
    timers.get(identity)?.abort();
    const waiter = waiters.get(identity);
    if (waiter === undefined) return;
    const task = tasks.get(record.input.handle);
    if (task.ok) await options.deliver(task.value);
    // No callback consumed this waiter: claim, delivery or storage failed.
    // A completed delivery attempt must not leave a terminal wait hanging.
    if (waiters.get(identity) === waiter) {
      waiter.dispose();
      waiter.resolve(err({ code: "recovery-required" }));
    }
  }
  function deadline(record: QuestionRecord) {
    const identity = key(record.input.handle);
    if (closed || record.settlement !== null || timers.has(identity)) return;
    const stop = new AbortController();
    timers.set(identity, stop);
    void clock
      .waitUntil(instant(record.expiresAt), stop.signal)
      .then(async (result) => {
        if (result !== "reached" || closed) return;
        const changed = store.change(record.input.handle, (current) =>
          current.settlement !== null
            ? ok(current)
            : ok(settle(current, "expired", hash(["expired", current.intent]))),
        );
        if (!changed.ok) {
          recoveryFailed = true;
          const waiter = waiters.get(identity);
          waiter?.dispose();
          waiter?.resolve(err({ code: "recovery-required" }));
          return;
        }
        await notifyOwner(changed.value);
      })
      .catch(() => {
        recoveryFailed = true;
      })
      .finally(() => {
        if (timers.get(identity) === stop) timers.delete(identity);
      });
  }
  async function admit<T>(
    resources: ProductTaskResources,
    operation: string,
    input: unknown,
    signal: AbortSignal,
    run: (signal: AbortSignal) => QuestionResult<T>,
  ): Promise<QuestionResult<T>> {
    if (closed) return err({ code: "unavailable" });
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(input));
    } catch {
      return err({ code: "malformed" });
    }
    if (bytes > 65_536) return err({ code: "resource-exhausted" });
    try {
      const result = await resources.execute({
        operation: randomUUID(),
        attempt: "1",
        generation: resources.generation,
        inputBytes: bytes,
        amounts: { operations: 1, concurrency: 1, memoryBytes: 262_144 },
        signal,
        unit: {
          id: workUnitId(randomUUID()),
          effect: "mutation",
          priority: "interactive",
          conflictKeys: [conflictKey("question", operation)],
          dependencies: [],
          deadline: null,
          expectedOutputBytes: 65_536,
          retry: NO_RETRY,
          scopeId: null,
        },
        async run(stop) {
          return { value: run(stop), terminated: true };
        },
      });
      return result.kind === "completed" ? result.value : err({ code: result.receipt.state });
    } catch {
      return err({ code: "storage-unavailable" });
    }
  }
  function ownerControl(
    handle: ProcessTaskHandle,
    credential: string,
    resources: ProductTaskResources,
  ) {
    const identity = key(handle);
    if (closed) return null;
    if (!ownerSubscriptions.has(identity) && ownerSubscriptions.size >= 256) return null;
    ownerSubscriptions.get(identity)?.();
    let ownerClosed = false;
    const stop = resources.onClose(() => {
      ownerClosed = true;
      if (closed) return;
      const changed = store.change(handle, (current) =>
        !matches(credential, current.ownerKey)
          ? err({ code: "denied" })
          : current.settlement !== null
            ? ok(current)
            : ok(settle(current, "cancelled", hash(["cancelled", current.intent]))),
      );
      if (changed.ok) void notifyOwner(changed.value);
    });
    if (stop === null || ownerClosed) {
      stop?.();
      return null;
    }
    ownerSubscriptions.set(identity, stop);
    async function change(kind: "publish" | "cancel", signal: AbortSignal) {
      const result = await admit(resources, handle.taskId, { kind, handle }, signal, (stop) =>
        store.change(
          handle,
          (current) => {
            if (!matches(credential, current.ownerKey)) return err({ code: "denied" });
            if (current.settlement !== null) return ok(current);
            if (now() >= current.expiresAt)
              return ok(settle(current, "expired", hash(["expired", current.intent])));
            if (kind === "cancel")
              return ok(settle(current, "cancelled", hash(["cancelled", current.intent])));
            if (current.state !== "created") return ok(current);
            if (current.revision >= 63)
              return ok(settle(current, "unavailable", hash(["unavailable", current.intent])));
            if (
              current.input.missingPresenter === "unavailable" &&
              current.presenter !== "connected"
            )
              return ok(settle(current, "unavailable", hash(["unavailable", current.intent])));
            return ok({
              ...current,
              revision: current.revision + 1,
              state: current.presenter === "connected" ? "published" : "waiting",
            });
          },
          stop,
        ),
      );
      if (result.ok) {
        deadline(result.value);
        await notifyOwner(result.value);
        return ok(questionDto(result.value));
      }
      return result;
    }
    return {
      publish: (signal: AbortSignal) => change("publish", signal),
      cancel: (signal: AbortSignal) => change("cancel", signal),
      inspect() {
        const result = authorized(handle, credential, "owner");
        return result.ok ? ok(questionDto(result.value)) : result;
      },
      wait(signal: AbortSignal): Promise<QuestionResult<QuestionSettlement>> {
        if (closed) return Promise.resolve(err({ code: "unavailable" }));
        const record = authorized(handle, credential, "owner");
        if (!record.ok) return Promise.resolve(record);
        if (signal.aborted) return Promise.resolve(err({ code: "cancelled" }));
        if (record.value.settlement !== null) {
          const wake = tasks.wake(handle);
          if (wake.ok && wake.value.state === "acknowledged")
            return Promise.resolve(ok(record.value.settlement));
        }
        if (waiters.size >= 64 || waiters.has(key(handle)))
          return Promise.resolve(err({ code: "resource-exhausted" }));
        return new Promise((resolve) => {
          const dispose = () => {
            signal.removeEventListener("abort", abort);
            waiters.delete(key(handle));
          };
          const abort = () => {
            dispose();
            resolve(err({ code: "cancelled" }));
          };
          waiters.set(key(handle), { resolve, dispose });
          signal.addEventListener("abort", abort, { once: true });
          // Register before reading committed settlement, closing the fast-answer race.
          const current = authorized(handle, credential, "owner");
          if (!current.ok) {
            dispose();
            resolve(current);
          } else {
            deadline(current.value);
            void notifyOwner(current.value);
          }
        });
      },
      async cleanup(signal: AbortSignal) {
        const result = await admit(resources, handle.taskId, { handle }, signal, (stop) =>
          store.cleanup(hash(credential), now(), stop),
        );
        if (result.ok && result.value > 0) {
          ownerSubscriptions.get(identity)?.();
          ownerSubscriptions.delete(identity);
        }
        return result;
      },
    };
  }
  return {
    /** Called by the admitted host with its own durable lineage, never deserialized model input. */
    async create(
      ownerInput: QuestionOwner,
      resources: ProductTaskResources,
      input: unknown,
      signal: AbortSignal,
    ) {
      const parsed = questionInputSchema.safeParse(input);
      const owner = questionOwnerSchema.safeParse(ownerInput);
      if (!parsed.success || !owner.success) return err({ code: "malformed" });
      if (
        owner.data.resourceTaskId !== resources.id ||
        owner.data.generation !== resources.generation ||
        resources.remaining("wallTimeMs") === 0
      )
        return err({ code: "denied" });
      const ownerToken = token(),
        presenterToken = token();
      const createdAt = now();
      const record: QuestionRecord = {
        input: parsed.data,
        owner: owner.data,
        ownerKey: hash(ownerToken),
        presenterKey: hash(presenterToken),
        intent: hash([owner.data, parsed.data]),
        revision: 1,
        createdAt,
        expiresAt: Math.min(createdAt + parsed.data.waitMs, resources.expiresAt),
        state: "created",
        presenter: "unavailable",
        settlement: null,
      };
      const result = await admit(
        resources,
        parsed.data.handle.taskId,
        parsed.data,
        signal,
        (stop) => store.create(record, stop),
      );
      if (!result.ok) return result;
      const control = ownerControl(record.input.handle, ownerToken, resources);
      if (control === null) {
        // Admission can finish just before the resource owner closes. Never leave
        // that committed request active without its cancellation subscription.
        const cancelled = store.change(record.input.handle, (current) =>
          current.settlement === null
            ? ok(settle(current, "cancelled", hash(["cancelled", current.intent])))
            : ok(current),
        );
        return cancelled.ok ? err({ code: "owner-cancelled" }) : cancelled;
      }
      deadline(record);
      // Tokens are host capabilities. They are deliberately absent from every DTO and event.
      return ok({ request: questionDto(record), ownerToken, presenterToken, control });
    },
    resume(handle: ProcessTaskHandle, credential: unknown, resources: ProductTaskResources) {
      const current = authorized(handle, credential, "owner");
      if (
        !current.ok ||
        typeof credential !== "string" ||
        resources.generation !== current.value.owner.generation ||
        resources.remaining("wallTimeMs") === 0
      )
        return err({ code: "denied" });
      const control = ownerControl(handle, credential, resources);
      return control === null ? err({ code: "unavailable" }) : ok(control);
    },
    async presenter(
      handle: ProcessTaskHandle,
      credential: unknown,
      principal: QuestionInput["presenter"],
      action: "connect" | "disconnect" | "answer" | "refuse",
      input: unknown,
      resources: ProductTaskResources,
      signal: AbortSignal,
    ) {
      // Invalid credentials see the same response for absent, stale, active and terminal requests.
      const access = authorized(handle, credential, "presenter", principal);
      if (!access.ok) return access;
      if (!["connect", "disconnect", "answer", "refuse"].includes(action))
        return err({ code: "malformed" });
      let answer: QuestionAnswer | null = null;
      if (action === "answer") {
        const parsed = questionAnswerSchema.safeParse(input);
        if (!parsed.success || !validQuestionAnswer(access.value.input, parsed.data))
          return err({ code: "malformed" });
        answer = parsed.data
          .map((a) => (a.kind === "selection" ? { ...a, optionIds: [...a.optionIds].sort() } : a))
          .sort((a, b) => a.itemId.localeCompare(b.itemId));
      }
      const answerDigest = hash([action, access.value.input.presenter, answer]);
      const result = await admit(resources, handle.taskId, { action, input }, signal, (stop) =>
        store.change(
          handle,
          (current) => {
            if (
              !matches(credential, current.presenterKey) ||
              !samePresenter(principal, current.input.presenter)
            )
              return err({ code: "denied" });
            if (current.settlement !== null)
              return current.settlement.digest === answerDigest
                ? ok(current)
                : err({ code: "conflicting-answer" });
            if (now() >= current.expiresAt)
              return ok(settle(current, "expired", hash(["expired", current.intent])));
            if (action === "connect" || action === "disconnect") {
              const presenter = action === "connect" ? "connected" : "disconnected";
              if (current.presenter === presenter) return ok(current);
              if (current.revision >= 63) return err({ code: "resource-exhausted" });
              return ok({
                ...current,
                revision: current.revision + 1,
                presenter,
                state: current.state === "created" ? "created" : "waiting",
              });
            }
            if (current.state === "created") return err({ code: "not-published" });
            if (current.presenter !== "connected") return err({ code: "disconnected-presenter" });
            return ok(
              settle(current, action === "answer" ? "answered" : "refused", answerDigest, answer),
            );
          },
          stop,
        ),
      );
      if (result.ok) {
        await notifyOwner(result.value);
        return ok(questionDto(result.value));
      }
      return result;
    },
    inspect(handle: ProcessTaskHandle, credential: unknown, principal: QuestionInput["presenter"]) {
      const result = authorized(handle, credential, "presenter", principal);
      return result.ok ? ok(questionDto(result.value)) : result;
    },
    async notify(notice: ProcessTaskNotification, signal: AbortSignal): Promise<boolean> {
      if (closed || signal.aborted || notice.task.executionKind !== "question") return false;
      const waiter = waiters.get(key(notice.task.handle));
      if (!waiter) return false;
      const record = store.get(notice.task.handle);
      if (!record.ok || record.value.settlement === null) return false;
      waiter.dispose();
      waiter.resolve(ok(record.value.settlement));
      return true;
    },
    recover() {
      const records = store.active();
      if (!records.ok) return records;
      for (const record of records.value) deadline(record);
      return ok(records.value.map(questionDto));
    },
    close() {
      closed = true;
      for (const stop of timers.values()) stop.abort();
      timers.clear();
      for (const unsubscribe of ownerSubscriptions.values()) unsubscribe();
      ownerSubscriptions.clear();
      for (const waiter of [...waiters.values()]) {
        waiter.dispose();
        waiter.resolve(err({ code: "unavailable" }));
      }
      return !recoveryFailed;
    },
  };
}
export type StructuredQuestions = ReturnType<typeof createStructuredQuestions>;
