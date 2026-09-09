import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { openProductStoreOrThrow, removeTemporaryRoots } from "../../data/fixtures.ts";
import { createSqliteProcessTaskStore } from "../../data/orchestration/process-task-store.ts";
import { createQuestionStore } from "../../data/orchestration/question-store.ts";
import { duration } from "../../domain/foundation/clock.ts";
import {
  type QuestionInput,
  questionAnswerSchema,
  questionInputSchema,
} from "../../domain/orchestration/question.ts";
import type { SqliteStorePort } from "../../domain/storage/index.ts";
import { localPath } from "../../domain/workspace/index.ts";
import { createProcessTaskFixture, taskValue } from "./process-task.fixtures.ts";
import { reconcileProcessTasks } from "./process-task-recovery.ts";
import { createProcessTaskSupervisor } from "./process-task-supervisor.ts";
import { createProductResources } from "./product-resources.ts";
import { createStructuredQuestions, type StructuredQuestions } from "./structured-questions.ts";

afterEach(removeTemporaryRoots);
const signal = new AbortController().signal;
const principal: QuestionInput["presenter"] = {
  actorId: "user",
  channel: "local-user",
  bindingId: "console",
};
const answer = [{ itemId: "choice", kind: "selection" as const, optionIds: ["a"] }];
function input(overrides: Partial<QuestionInput> = {}): QuestionInput {
  return {
    version: 1,
    handle: { version: 1, taskId: randomUUID(), generation: "question-1" },
    items: [
      {
        id: "choice",
        kind: "single-select",
        prompt: "Choose a value",
        options: [
          { id: "a", label: "One" },
          { id: "b", label: "Two" },
        ],
      },
    ],
    sensitivity: "normal",
    retention: "answer",
    presenter: principal,
    waitMs: 15_000,
    missingPresenter: "wait",
    ...overrides,
  };
}
async function fixture() {
  const f = await createProcessTaskFixture();
  const resources = createProductResources(f.clock);
  const budget = resources.openTask("owner-generation");
  const presenterBudget = resources.openTask("presenter-generation");
  let notifications = 0;
  function attach(database: SqliteStorePort) {
    const tasks = createSqliteProcessTaskStore(database);
    const store = createQuestionStore(database, { runId: "question-run", process: null });
    let questions: StructuredQuestions;
    const supervisor = createProcessTaskSupervisor({
      store: tasks,
      artifacts: f.artifacts,
      clock: f.clock,
      runId: "question-run",
      process: null,
      async notify(notice, signal) {
        notifications++;
        return questions.notify(notice, signal);
      },
    });
    questions = createStructuredQuestions({
      store,
      tasks,
      clock: f.clock,
      deliver: supervisor.deliver,
    });
    return { questions, store, tasks };
  }
  const runtime = attach(f.database);
  const owner = { ...f.snapshot.owner, resourceTaskId: budget.id, generation: budget.generation };
  async function create(request = input()) {
    return taskValue(await runtime.questions.create(owner, budget, request, signal));
  }
  async function present(
    created: Awaited<ReturnType<typeof create>>,
    action: "connect" | "disconnect" | "answer" | "refuse",
    value: unknown = null,
  ) {
    return runtime.questions.presenter(
      created.request.handle,
      created.presenterToken,
      principal,
      action,
      value,
      presenterBudget,
      signal,
    );
  }
  return {
    ...f,
    ...runtime,
    resources,
    budget,
    presenterBudget,
    owner,
    create,
    present,
    attach,
    get notifications() {
      return notifications;
    },
    async dispose() {
      runtime.questions.close();
      resources.shutdown();
      await f.close();
    },
  };
}

test("publication commits ownership before answering, normalizes replay and wakes the owner once", async () => {
  const f = await fixture();
  try {
    const c = await f.create();
    expect(f.tasks.get(c.request.handle).ok).toBe(true);
    expect(await f.present(c, "answer", answer)).toMatchObject({
      ok: false,
      error: { code: "not-published" },
    });
    taskValue(await f.present(c, "connect"));
    const waiting = c.control.wait(signal);
    taskValue(await c.control.publish(signal));
    const settled = taskValue(await f.present(c, "answer", answer));
    expect(taskValue(await waiting)).toMatchObject({
      kind: "answered",
      answer,
      effectAuthority: false,
    });
    expect(f.notifications).toBe(1);
    expect(taskValue(await f.present(c, "answer", answer))).toEqual(settled);
    expect(f.notifications).toBe(1);
    expect(await f.present(c, "answer", [{ ...answer[0], optionIds: ["b"] }])).toMatchObject({
      ok: false,
      error: { code: "conflicting-answer" },
    });
    expect(taskValue(f.tasks.wake(c.request.handle))).toMatchObject({
      state: "acknowledged",
      attempts: 1,
    });
    const rows = taskValue(
      f.database.read("SELECT payload FROM events WHERE kind='process.task.changed'"),
    );
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("Choose a value");
    expect(serialized).not.toContain(c.ownerToken);
    expect(serialized).not.toContain(c.presenterToken);
    expect(rows.filter((r) => String(r.payload).includes('"change":"sealed"'))).toHaveLength(1);
  } finally {
    await f.dispose();
  }
});

test("forged credentials, other actors and stale generations disclose no request or settlement", async () => {
  const f = await fixture();
  try {
    const c = await f.create();
    for (const handle of [
      c.request.handle,
      { ...c.request.handle, taskId: "missing" },
      { ...c.request.handle, generation: "stale" },
    ]) {
      expect(f.questions.inspect(handle, "forged", principal)).toEqual({
        ok: false,
        error: { code: "denied" },
      });
    }
    expect(
      f.questions.inspect(c.request.handle, c.presenterToken, { ...principal, actorId: "model" }),
    ).toEqual({ ok: false, error: { code: "denied" } });
    expect(f.questions.resume(c.request.handle, c.presenterToken, f.budget)).toEqual({
      ok: false,
      error: { code: "denied" },
    });
    taskValue(await c.control.publish(signal));
    expect(await f.present(c, "answer", answer)).toMatchObject({
      ok: false,
      error: { code: "disconnected-presenter" },
    });
    taskValue(await f.present(c, "connect"));
    taskValue(await f.present(c, "disconnect"));
    expect(c.control.inspect()).toMatchObject({
      ok: true,
      value: { state: "waiting", presenter: "disconnected", settlement: null },
    });
    taskValue(await f.present(c, "connect"));
    const a = await f.questions.presenter(
      c.request.handle,
      c.presenterToken,
      { bindingId: "console", channel: "local-user", actorId: "user" },
      "answer",
      answer,
      f.presenterBudget,
      signal,
    );
    expect(a).toMatchObject({ ok: true, value: { state: "answered" } });
  } finally {
    await f.dispose();
  }
});

test("expiry, explicit refusal, absent presenter and owner cancellation remain distinct", async () => {
  const f = await fixture();
  try {
    const expired = await f.create(input({ waitMs: 50 }));
    taskValue(await expired.control.publish(signal));
    const wait = expired.control.wait(signal);
    await f.clock.advance(duration(50));
    expect(taskValue(await wait).kind).toBe("expired");
    const refused = await f.create();
    taskValue(await f.present(refused, "connect"));
    taskValue(await refused.control.publish(signal));
    expect(taskValue(await f.present(refused, "refuse")).settlement?.kind).toBe("refused");
    const absent = await f.create(input({ missingPresenter: "unavailable" }));
    expect(taskValue(await absent.control.publish(signal)).state).toBe("unavailable");
    const cancelled = await f.create();
    taskValue(await cancelled.control.publish(signal));
    const cancelledWait = cancelled.control.wait(signal);
    f.budget.close();
    expect(taskValue(await cancelledWait).kind).toBe("cancelled");
    expect(await f.present(cancelled, "answer", answer)).toMatchObject({
      ok: false,
      error: { code: "conflicting-answer" },
    });
  } finally {
    await f.dispose();
  }
});

test("restart rebuilds pending questions, restores deadlines and uses the existing durable wake outbox", async () => {
  const f = await fixture();
  let reopened: SqliteStorePort | undefined;
  let restored: StructuredQuestions | undefined;
  try {
    const c = await f.create();
    taskValue(await f.present(c, "connect"));
    taskValue(await c.control.publish(signal));
    const root = dirname(String(f.database.report.path));
    f.questions.close();
    await f.database.close();
    reopened = await openProductStoreOrThrow(localPath(root));
    const runtime = f.attach(reopened);
    restored = runtime.questions;
    expect(taskValue(restored.recover())).toHaveLength(1);
    const reports = await reconcileProcessTasks({
      store: runtime.tasks,
      identities: {
        async inspect() {
          throw new Error("question recovery must not probe a process");
        },
      },
      now: () => 20_000,
    });
    expect(taskValue(reports)).toEqual([]);
    const newBudget = f.resources.openTask("owner-generation");
    const control = taskValue(restored.resume(c.request.handle, c.ownerToken, newBudget));
    const waiting = control.wait(signal);
    taskValue(
      await restored.presenter(
        c.request.handle,
        c.presenterToken,
        principal,
        "answer",
        answer,
        f.presenterBudget,
        signal,
      ),
    );
    expect(taskValue(await waiting).kind).toBe("answered");
    expect(taskValue(runtime.tasks.wake(c.request.handle)).state).toBe("acknowledged");
    expect(taskValue(await control.wait(signal)).kind).toBe("answered");
    expect(f.notifications).toBe(1);
  } finally {
    restored?.close();
    await reopened?.close();
    await f.dispose();
  }
});

test("competing writers publish one terminal event and an answer can settle before owner reconnection", async () => {
  const f = await fixture();
  const second = await openProductStoreOrThrow(localPath(dirname(String(f.database.report.path))));
  const other = f.attach(second);
  try {
    const c = await f.create();
    taskValue(await f.present(c, "connect"));
    taskValue(await c.control.publish(signal));
    const results = await Promise.all([
      f.present(c, "answer", answer),
      other.questions.presenter(
        c.request.handle,
        c.presenterToken,
        principal,
        "refuse",
        null,
        f.presenterBudget,
        signal,
      ),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(taskValue(f.tasks.wake(c.request.handle))).toMatchObject({
      state: "pending",
      attempts: 0,
    });
    expect(taskValue(await c.control.wait(signal)).kind).toBe("answered");
    const rows = taskValue(f.database.read("SELECT notification_id FROM process_task_wakes"));
    expect(rows).toHaveLength(1);
  } finally {
    other.questions.close();
    await second.close();
    await f.dispose();
  }
});

test("protected input persists only non-retention; metadata-only answers and cleanup omit answer bytes", async () => {
  const f = await fixture();
  try {
    const c = await f.create(
      input({ sensitivity: "protected", retention: "metadata-only", waitMs: 50 }),
    );
    taskValue(await f.present(c, "connect"));
    taskValue(await c.control.publish(signal));
    expect(
      await f.present(c, "answer", [
        { itemId: "choice", kind: "text", text: "never-persist-this-secret" },
      ]),
    ).toMatchObject({ ok: false, error: { code: "malformed" } });
    const waiting = c.control.wait(signal);
    taskValue(
      await f.present(c, "answer", [{ itemId: "choice", kind: "protected", retained: false }]),
    );
    expect(taskValue(await waiting)).toMatchObject({
      kind: "answered",
      answer: null,
      retained: false,
    });
    expect(
      JSON.stringify(taskValue(f.database.read("SELECT record FROM question_revisions"))),
    ).not.toContain("never-persist-this-secret");
    await f.clock.advance(duration(50));
    expect(taskValue(await c.control.cleanup(signal))).toBe(1);
    expect(taskValue(f.database.read("SELECT * FROM question_revisions"))).toEqual([]);
    expect(f.store.get(c.request.handle)).toMatchObject({
      ok: false,
      error: { code: "not-found" },
    });
    expect(
      await f.create(input({ handle: c.request.handle })).then(
        () => "created",
        () => "refused",
      ),
    ).toBe("refused");
  } finally {
    await f.dispose();
  }
});

test("limits reject invalid option sets, oversized Unicode and active owner overflow", async () => {
  expect(
    questionInputSchema.safeParse(
      input({
        items: [
          { id: "x", kind: "free-text", prompt: "猫".repeat(8192), maxBytes: 3 },
          { id: "y", kind: "free-text", prompt: "猫".repeat(8192), maxBytes: 3 },
        ],
      }),
    ).success,
  ).toBe(false);
  expect(
    questionAnswerSchema.safeParse([{ itemId: "x", kind: "text", text: "猫".repeat(6000) }])
      .success,
  ).toBe(false);
  const f = await fixture();
  try {
    for (let i = 0; i < 8; i++) await f.create();
    expect(await f.questions.create(f.owner, f.budget, input(), signal)).toMatchObject({
      ok: false,
      error: { code: "resource-exhausted" },
    });
    expect(taskValue(f.store.active())).toHaveLength(8);
    const aborted = new AbortController();
    aborted.abort();
    expect(await f.questions.create(f.owner, f.budget, input(), aborted.signal)).toMatchObject({
      ok: false,
    });
  } finally {
    await f.dispose();
  }
});

test("failed publication rolls back task event and question revision together; corrupt rows fail closed", async () => {
  const f = await fixture();
  try {
    const c = await f.create();
    taskValue(
      f.database.write((sql) =>
        sql.run(
          "CREATE TRIGGER question_fault BEFORE INSERT ON question_revisions WHEN NEW.revision=2 BEGIN SELECT RAISE(ABORT,'injected'); END",
        ),
      ),
    );
    expect(await c.control.publish(signal)).toMatchObject({ ok: false });
    expect(taskValue(f.store.get(c.request.handle)).revision).toBe(1);
    expect(taskValue(f.tasks.get(c.request.handle)).revision).toBe(1);
    taskValue(
      f.database.write((sql) => {
        sql.run("DROP TRIGGER question_fault");
        sql.run("UPDATE question_revisions SET record='{}'");
      }),
    );
    expect(f.questions.recover()).toMatchObject({ ok: false, error: { code: "corrupt" } });
    expect(f.questions.inspect(c.request.handle, c.presenterToken, principal)).toMatchObject({
      ok: false,
      error: { code: "denied" },
    });
  } finally {
    await f.dispose();
  }
});

test("mixed items validate complete semantic answers and normalize selection replay", async () => {
  const f = await fixture();
  try {
    const c = await f.create(
      input({
        items: [
          {
            id: "multi",
            kind: "multi-select",
            prompt: "Choose",
            options: [
              { id: "a", label: "A" },
              { id: "b", label: "B" },
            ],
            minimum: 0,
            maximum: 2,
          },
          { id: "text", kind: "free-text", prompt: "Name", maxBytes: 3 },
          { id: "review", kind: "review", prompt: "Read this" },
        ],
      }),
    );
    taskValue(await f.present(c, "connect"));
    taskValue(await c.control.publish(signal));
    const values = [
      { itemId: "multi", kind: "selection", optionIds: ["b", "a"] },
      { itemId: "text", kind: "text", text: "猫" },
      { itemId: "review", kind: "review", acknowledged: true },
    ];
    for (const invalid of [
      values.slice(1),
      [values[0], values[0], values[2]],
      [{ ...values[0], optionIds: ["a", "a"] }, ...values.slice(1)],
      [values[0], { ...values[1], text: "猫猫" }, values[2]],
    ])
      expect(await f.present(c, "answer", invalid)).toMatchObject({
        ok: false,
        error: { code: "malformed" },
      });
    const result = taskValue(await f.present(c, "answer", values));
    expect(
      taskValue(
        await f.present(c, "answer", [
          values[2],
          values[1],
          { ...values[0], optionIds: ["a", "b"] },
        ]),
      ),
    ).toEqual(result);
    expect(result.settlement?.effectAuthority).toBe(false);
  } finally {
    await f.dispose();
  }
});

test("bounded presenter churn leaves a terminal revision available", async () => {
  const f = await fixture();
  try {
    const c = await f.create(input({ waitMs: 50 }));
    for (let i = 0; i < 62; i++)
      taskValue(await f.present(c, i % 2 === 0 ? "connect" : "disconnect"));
    expect(taskValue(c.control.inspect()).revision).toBe(63);
    expect(await f.present(c, "connect")).toMatchObject({
      ok: false,
      error: { code: "resource-exhausted" },
    });
    expect(taskValue(await c.control.publish(signal))).toMatchObject({
      revision: 64,
      state: "unavailable",
    });
    expect(taskValue(await c.control.wait(signal)).kind).toBe("unavailable");
  } finally {
    await f.dispose();
  }
});

test("owner closure between admission and handle publication cancels the committed request", async () => {
  const f = await fixture();
  try {
    const request = input();
    const resources = {
      ...f.budget,
      execute: async <T>(...args: Parameters<typeof f.budget.execute<T>>) => {
        const result = await f.budget.execute<T>(...args);
        f.budget.close();
        return result;
      },
    };
    expect(await f.questions.create(f.owner, resources, request, signal)).toMatchObject({
      ok: false,
      error: { code: "owner-cancelled" },
    });
    expect(taskValue(f.store.get(request.handle)).state).toBe("cancelled");
    expect(taskValue(f.tasks.wake(request.handle)).state).toBe("pending");
  } finally {
    await f.dispose();
  }
});

test("answer and cancellation race once; exhausted notification delivery cannot hang a waiter", async () => {
  const f = await fixture();
  try {
    const c = await f.create();
    taskValue(await f.present(c, "connect"));
    taskValue(await c.control.publish(signal));
    await Promise.all([c.control.cancel(signal), f.present(c, "answer", answer)]);
    expect(taskValue(f.store.get(c.request.handle)).state).toBe("cancelled");
    taskValue(
      f.database.write((sql) =>
        sql.run("UPDATE process_task_wakes SET attempts=3,state='unavailable'"),
      ),
    );
    expect(await c.control.wait(signal)).toMatchObject({
      ok: false,
      error: { code: "recovery-required" },
    });
  } finally {
    await f.dispose();
  }
});
