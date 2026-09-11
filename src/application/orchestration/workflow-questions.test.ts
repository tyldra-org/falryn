import { afterEach, expect, test } from "bun:test";
import { removeTemporaryRoots } from "../../data/fixtures.ts";
import { createSqliteProcessTaskStore } from "../../data/orchestration/process-task-store.ts";
import { createQuestionStore } from "../../data/orchestration/question-store.ts";
import { simpleWorkflow } from "../../domain/orchestration/workflow.fixtures.ts";
import { taskValue } from "./process-task.fixtures.ts";
import { createProcessTaskSupervisor } from "./process-task-supervisor.ts";
import { createStructuredQuestions, type StructuredQuestions } from "./structured-questions.ts";
import { workflowFixture } from "./workflow-execution.fixtures.ts";
import { createWorkflowQuestions } from "./workflow-questions.ts";

afterEach(removeTemporaryRoots);
const principal = { actorId: "user", channel: "local-user" as const, bindingId: "console" };
const signal = new AbortController().signal;
const handle = { id: "question-workflow", generation: "one" };
const definition = {
  ...simpleWorkflow(),
  nodes: [
    {
      key: "choice",
      kind: "question",
      resultPath: ["state"],
      resultSchema: { type: "string", enum: ["answered"] },
      request: {
        items: [
          {
            id: "choice",
            kind: "single-select",
            prompt: "Choose",
            options: [
              { id: "a", label: "One" },
              { id: "b", label: "Two" },
            ],
          },
        ],
        sensitivity: "normal",
        retention: "answer",
        waitMs: 15000,
        missingPresenter: "wait",
      },
    },
  ],
  outputs: { state: { from: "node", node: "choice" } },
};

test("headless waits survive owner restart and require original question capabilities before continuing", async () => {
  const f = await workflowFixture();
  function attach() {
    const tasks = createSqliteProcessTaskStore(f.database);
    let questions: StructuredQuestions;
    const supervisor = createProcessTaskSupervisor({
      store: tasks,
      artifacts: f.nativeArtifacts,
      clock: f.clock,
      runId: "workflow-test",
      process: null,
      notify: (notice, stop) => questions.notify(notice, stop),
    });
    questions = createStructuredQuestions({
      store: createQuestionStore(f.database, { runId: "workflow-test", process: null }),
      tasks,
      clock: f.clock,
      deliver: supervisor.deliver,
    });
    const bridge = createWorkflowQuestions(questions, principal);
    const host = {
      ...f.host,
      execute: ((node, input, record, instance, _resources, stop) =>
        bridge.create(
          node,
          input,
          record,
          instance,
          f.host.resources,
          stop,
        )) as typeof f.host.execute,
      question: bridge.inspect,
      wait: bridge.wait,
    };
    return { questions, bridge, host };
  }
  let runtime = attach();
  const captured =
    Promise.withResolvers<Parameters<Parameters<typeof runtime.bridge.subscribe>[0]>[0]>();
  runtime.bridge.subscribe((created) => {
    captured.resolve(created);
  });
  try {
    taskValue(await f.execution.admit({ handle, definition, arguments: {} }, runtime.host, signal));
    const waiting = taskValue(await f.execution.drive(handle, runtime.host, signal));
    const created = await captured.promise;
    expect(waiting.state).toBe("waiting");
    expect(waiting.nodes[0]).toMatchObject({
      state: "waiting",
      attempts: 1,
      question: created.request.handle,
    });
    expect(JSON.stringify(waiting)).not.toContain(created.ownerToken);
    expect(JSON.stringify(waiting)).not.toContain(created.presenterToken);
    expect(runtime.questions.close()).toBe(true);
    runtime = attach();
    const node = waiting.nodes[0];
    if (!node) throw new Error("Missing waiting node");
    expect(runtime.bridge.restore(waiting, node, "forged", f.host.resources)).toBe(false);
    expect(
      runtime.bridge.restore(
        waiting,
        { ...node, question: { ...created.request.handle, generation: "other" } },
        created.ownerToken,
        f.host.resources,
      ),
    ).toBe(false);
    expect(taskValue(await f.execution.drive(handle, runtime.host, signal)).state).toBe("waiting");
    expect(runtime.bridge.restore(waiting, node, created.ownerToken, f.host.resources)).toBe(true);
    taskValue(
      await runtime.questions.presenter(
        created.request.handle,
        created.presenterToken,
        principal,
        "connect",
        null,
        f.host.resources,
        signal,
      ),
    );
    const notified = runtime.bridge.wait(waiting, signal);
    taskValue(
      await runtime.questions.presenter(
        created.request.handle,
        created.presenterToken,
        principal,
        "answer",
        [{ itemId: "choice", kind: "selection", optionIds: ["a"] }],
        f.host.resources,
        signal,
      ),
    );
    await notified;
    const done = taskValue(await f.execution.drive(handle, runtime.host, signal));
    expect(done.state).toBe("completed");
    expect(done.nodes[0]?.attempts).toBe(1);
    if (!done.output) throw new Error("Missing output");
    expect(await f.artifacts.read(done.output, signal)).toEqual({ state: "answered" });
    expect(JSON.stringify(done)).not.toContain("optionIds");
  } finally {
    runtime.questions.close();
    await f.close();
  }
});
