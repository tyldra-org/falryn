/** A real structured-question service with a local presenter over it, for presenter and sheet tests. */
import { randomUUID } from "node:crypto";
import { removeTemporaryRoots } from "../../data/fixtures.ts";
import { createSqliteProcessTaskStore } from "../../data/orchestration/process-task-store.ts";
import { createQuestionStore } from "../../data/orchestration/question-store.ts";
import type { QuestionInput } from "../../domain/orchestration/question.ts";
import { createProcessTaskFixture, taskValue } from "./process-task.fixtures.ts";
import { createProcessTaskSupervisor } from "./process-task-supervisor.ts";
import { createProductResources } from "./product-resources.ts";
import { createLocalQuestionPresenter } from "./question-presenter.ts";
import { createStructuredQuestions, type StructuredQuestions } from "./structured-questions.ts";

export const PRESENTER_PRINCIPAL: QuestionInput["presenter"] = {
  actorId: "local-user",
  channel: "local-user",
  bindingId: "workflow",
};
export const chooseOption = (optionId: string) => [
  { itemId: "choice", kind: "selection" as const, optionIds: [optionId] },
];

export async function questionPresenterFixture() {
  const signal = new AbortController().signal;
  const f = await createProcessTaskFixture();
  const resources = createProductResources(f.clock);
  const budget = resources.openTask("owner-generation");
  const tasks = createSqliteProcessTaskStore(f.database);
  let questions: StructuredQuestions;
  const supervisor = createProcessTaskSupervisor({
    store: tasks,
    artifacts: f.artifacts,
    clock: f.clock,
    runId: "question-run",
    process: null,
    notify: (notice, stop) => questions.notify(notice, stop),
  });
  questions = createStructuredQuestions({
    store: createQuestionStore(f.database, { runId: "question-run", process: null }),
    tasks,
    clock: f.clock,
    deliver: supervisor.deliver,
  });
  let scopes = 0;
  const presenter = createLocalQuestionPresenter({
    questions,
    openResources: () => {
      scopes++;
      return resources.openTask(`question-presenter-${scopes}`);
    },
  });
  const owner = { ...f.snapshot.owner, resourceTaskId: budget.id, generation: budget.generation };
  /** Create and publish one question the way a producer does, then offer it. */
  async function ask(overrides: Partial<QuestionInput> = {}) {
    const created = taskValue(
      await questions.create(
        owner,
        budget,
        {
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
          presenter: PRESENTER_PRINCIPAL,
          waitMs: 15_000,
          missingPresenter: "wait",
          ...overrides,
        },
        signal,
      ),
    );
    if (!(await created.control.publish(signal)).ok) throw new Error("question-not-published");
    const offered = await presenter.offer(created, PRESENTER_PRINCIPAL, "Workflow question");
    return { created, offered };
  }
  return {
    ...f,
    presenter,
    ask,
    get scopes() {
      return scopes;
    },
    async dispose() {
      presenter.close();
      questions.close();
      resources.shutdown();
      await f.close();
      await removeTemporaryRoots();
    },
  };
}
