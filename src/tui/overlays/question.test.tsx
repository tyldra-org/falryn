/**
 * The structured question sheet, on a real terminal over the real question service.
 *
 * Every answer here settles through the local presenter and the durable question
 * store; a key that should change nothing is checked against the service state,
 * not only against the frame.
 */

import { describe, expect, test } from "bun:test";
import { taskValue } from "../../application/orchestration/process-task.fixtures.ts";
import { createProcessTaskSupervisor } from "../../application/orchestration/process-task-supervisor.ts";
import { createProductResources } from "../../application/orchestration/product-resources.ts";
import {
  PRESENTER_PRINCIPAL,
  questionPresenterFixture,
} from "../../application/orchestration/question-presenter.fixtures.ts";
import { createLocalQuestionPresenter } from "../../application/orchestration/question-presenter.ts";
import {
  createStructuredQuestions,
  type StructuredQuestions,
} from "../../application/orchestration/structured-questions.ts";
import { workflowFixture } from "../../application/orchestration/workflow-execution.fixtures.ts";
import { createWorkflowQuestions } from "../../application/orchestration/workflow-questions.ts";
import { removeTemporaryRoots } from "../../data/fixtures.ts";
import { createSqliteProcessTaskStore } from "../../data/orchestration/process-task-store.ts";
import { createQuestionStore } from "../../data/orchestration/question-store.ts";
import { duration } from "../../domain/foundation/clock.ts";
import { simpleWorkflow } from "../../domain/orchestration/workflow.fixtures.ts";
import { mount } from "../runtime/harness.tsx";
import { ShellApp } from "../shell/shell-app.tsx";
import { known, type ShellModel, unavailable } from "../shell/view-model.ts";
import type { ThemeRequest } from "../theme/index.ts";

const THEME: ThemeRequest = {
  variant: "dark",
  colorLevel: "none",
  symbols: "unicode",
  reducedMotion: true,
  generation: 1,
};

const MODEL: Omit<ShellModel, "overlay" | "commands" | "transcript" | "composer" | "activity"> = {
  header: {
    workspace: known("/work/falryn"),
    branch: unavailable("no Git yet"),
    session: unavailable("no session yet"),
    model: unavailable("no provider yet"),
  },
  status: { status: "informational", message: "Nothing is running.", hints: [] },
  help: [{ title: "Leaving", body: "Ctrl+C ends the shell." }],
};

const SHAPE = { shape: { columns: 100, rows: 30 } };
const DOWN = "\u001b[B";
const signal = new AbortController().signal;

describe("a question sheet", () => {
  test("a workflow question published during a turn is answered and the workflow continues", async () => {
    const f = await workflowFixture();
    const tasks = createSqliteProcessTaskStore(f.database);
    let questions: StructuredQuestions;
    const supervisor = createProcessTaskSupervisor({
      store: tasks,
      artifacts: f.nativeArtifacts,
      clock: f.clock,
      runId: "workflow-sheet",
      process: null,
      notify: (notice, stop) => questions.notify(notice, stop),
    });
    questions = createStructuredQuestions({
      store: createQuestionStore(f.database, { runId: "workflow-sheet", process: null }),
      tasks,
      clock: f.clock,
      deliver: supervisor.deliver,
    });
    const scopes = createProductResources(f.clock);
    const presenter = createLocalQuestionPresenter({
      questions,
      openResources: () => scopes.openTask("question-presenter"),
    });
    // Composed the way the interactive product host composes it.
    const bridge = createWorkflowQuestions(questions, PRESENTER_PRINCIPAL);
    bridge.subscribe((created) =>
      presenter.offer(created, PRESENTER_PRINCIPAL, "Workflow question").then(() => {}),
    );
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
    const handle = { id: "question-sheet", generation: "one" };
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
                prompt: "Which branch should the release use?",
                options: [
                  { id: "main", label: "main" },
                  { id: "next", label: "next" },
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
    try {
      using shell = await mount(
        <ShellApp theme={THEME} model={MODEL} onExit={() => {}} questions={presenter} />,
        SHAPE,
      );
      taskValue(await f.execution.admit({ handle, definition, arguments: {} }, host, signal));
      const waiting = taskValue(await f.execution.drive(handle, host, signal));
      expect(waiting.state).toBe("waiting");
      const frame = await shell.frame("Which branch should the release use?");
      expect(frame).toContain("From Workflow question");
      expect(frame).toContain("expires within a minute");
      expect(frame).toContain("› ( ) main");
      expect(frame).toContain("Esc leaves this waiting");
      await shell.press(DOWN);
      await shell.frame("› ( ) next");
      const settled = bridge.wait(waiting, signal);
      await shell.pressEnter();
      expect(await shell.frame("Answer sent.")).not.toContain("Which branch");
      await settled;
      const done = taskValue(await f.execution.drive(handle, host, signal));
      expect(done.state).toBe("completed");
      if (!done.output) throw new Error("Missing output");
      expect(await f.artifacts.read(done.output, signal)).toEqual({ state: "answered" });
    } finally {
      presenter.close();
      questions.close();
      scopes.shutdown();
      await f.close();
      await removeTemporaryRoots();
    }
  });

  test("refusing settles the question as refused, never as an answer", async () => {
    const f = await questionPresenterFixture();
    try {
      const { created } = await f.ask();
      using shell = await mount(
        <ShellApp theme={THEME} model={MODEL} onExit={() => {}} questions={f.presenter} />,
        SHAPE,
      );
      await shell.frame("Choose a value");
      await shell.press("r", { ctrl: true });
      await shell.frame("Question refused.");
      const settled = await created.control.wait(signal);
      expect(settled.ok && settled.value).toMatchObject({ kind: "refused", answer: null });
    } finally {
      await f.dispose();
    }
  });

  test("two waiting questions are shown one after the other", async () => {
    const f = await questionPresenterFixture();
    try {
      const first = await f.ask();
      const second = await f.ask({
        items: [{ id: "choice", kind: "review", prompt: "Review the release notes" }],
      });
      using shell = await mount(
        <ShellApp theme={THEME} model={MODEL} onExit={() => {}} questions={f.presenter} />,
        SHAPE,
      );
      expect(await shell.frame("Choose a value")).toContain("1 more waiting");
      await shell.pressEnter();
      const next = await shell.frame("Review the release notes");
      expect(next).not.toContain("more waiting");
      await shell.pressEnter();
      await shell.frame("Answer sent.");
      expect((await first.created.control.wait(signal)).ok).toBe(true);
      const reviewed = await second.created.control.wait(signal);
      expect(reviewed.ok && reviewed.value).toMatchObject({
        kind: "answered",
        answer: [{ itemId: "choice", kind: "review", acknowledged: true }],
      });
    } finally {
      await f.dispose();
    }
  });

  test("leaving keeps the question waiting until it is shown again from the palette", async () => {
    const f = await questionPresenterFixture();
    try {
      const { created } = await f.ask();
      using shell = await mount(
        <ShellApp theme={THEME} model={MODEL} onExit={() => {}} questions={f.presenter} />,
        SHAPE,
      );
      await shell.frame("Choose a value");
      await shell.pressEscape();
      expect(await shell.frame("Question left waiting.")).not.toContain("Choose a value");
      expect(created.control.inspect()).toMatchObject({
        ok: true,
        value: { presenter: "disconnected", settlement: null },
      });
      await shell.press("p", { ctrl: true });
      await shell.type("waiting questions");
      await shell.frame("Show waiting questions");
      await shell.press("\r");
      await shell.frame("Choose a value");
      await shell.pressEnter();
      await shell.frame("Answer sent.");
      const settled = await created.control.wait(signal);
      expect(settled.ok && settled.value).toMatchObject({
        kind: "answered",
        answer: [{ itemId: "choice", kind: "selection", optionIds: ["a"] }],
      });
    } finally {
      await f.dispose();
    }
  });

  test("a multi-select answer must respect its minimum and maximum", async () => {
    const f = await questionPresenterFixture();
    try {
      const { created } = await f.ask({
        items: [
          {
            id: "choice",
            kind: "multi-select",
            prompt: "Pick the platforms",
            options: [
              { id: "mac", label: "macOS" },
              { id: "linux", label: "Linux" },
              { id: "win", label: "Windows" },
            ],
            minimum: 1,
            maximum: 2,
          },
        ],
      });
      using shell = await mount(
        <ShellApp theme={THEME} model={MODEL} onExit={() => {}} questions={f.presenter} />,
        SHAPE,
      );
      await shell.frame("Pick the platforms");
      await shell.pressEnter();
      await shell.frame("Choose at least 1.");
      await shell.press(" ");
      await shell.press(DOWN);
      await shell.press(" ");
      await shell.press(DOWN);
      await shell.press(" ");
      expect(await shell.frame("3 chosen")).toContain("[x] Windows");
      await shell.pressEnter();
      await shell.frame("Choose at most 2.");
      expect(created.control.inspect()).toMatchObject({ ok: true, value: { settlement: null } });
      await shell.press(" ");
      await shell.frame("2 chosen");
      await shell.pressEnter();
      await shell.frame("Answer sent.");
      const settled = await created.control.wait(signal);
      expect(settled.ok && settled.value).toMatchObject({
        kind: "answered",
        answer: [{ itemId: "choice", kind: "selection", optionIds: ["linux", "mac"] }],
      });
    } finally {
      await f.dispose();
    }
  });

  test("free text is bounded in bytes and over-limit input is refused whole", async () => {
    const f = await questionPresenterFixture();
    try {
      const { created } = await f.ask({
        items: [{ id: "choice", kind: "free-text", prompt: "Name the tag", maxBytes: 6 }],
      });
      using shell = await mount(
        <ShellApp theme={THEME} model={MODEL} onExit={() => {}} questions={f.presenter} />,
        SHAPE,
      );
      await shell.frame("Name the tag");
      await shell.type("v1 é");
      expect(await shell.frame("5 of 6 bytes")).toContain("› v1 é");
      await shell.type("é");
      await shell.frame("The answer is limited to 6 bytes.");
      await shell.pressBackspace();
      await shell.type("x");
      await shell.frame("› v1 x");
      await shell.pressEnter();
      await shell.frame("Answer sent.");
      const settled = await created.control.wait(signal);
      expect(settled.ok && settled.value).toMatchObject({
        kind: "answered",
        answer: [{ itemId: "choice", kind: "text", text: "v1 x" }],
      });
    } finally {
      await f.dispose();
    }
  });

  test("expiry and owner cancellation close the sheet without an answer", async () => {
    const f = await questionPresenterFixture();
    try {
      const expiring = await f.ask({ waitMs: 1_000 });
      using shell = await mount(
        <ShellApp theme={THEME} model={MODEL} onExit={() => {}} questions={f.presenter} />,
        SHAPE,
      );
      await shell.frame("Choose a value");
      await f.clock.advance(duration(1_500));
      f.presenter.refresh();
      expect(await shell.frame()).not.toContain("Choose a value");
      const expired = await expiring.created.control.wait(signal);
      expect(expired.ok && expired.value).toMatchObject({ kind: "expired", answer: null });

      const cancelled = await f.ask({
        items: [{ id: "choice", kind: "review", prompt: "Review the plan" }],
      });
      await shell.frame("Review the plan");
      expect((await cancelled.created.control.cancel(signal)).ok).toBe(true);
      f.presenter.refresh();
      expect(await shell.frame()).not.toContain("Review the plan");
      await shell.press("\r");
      expect(cancelled.created.control.inspect()).toMatchObject({
        ok: true,
        value: { settlement: { kind: "cancelled" } },
      });
    } finally {
      await f.dispose();
    }
  });

  test("a protected question is shown as unavailable and can only be refused or left", async () => {
    const f = await questionPresenterFixture();
    try {
      const { created } = await f.ask({
        items: [{ id: "choice", kind: "free-text", prompt: "Enter the signing key", maxBytes: 64 }],
        sensitivity: "protected",
        retention: "metadata-only",
      });
      using shell = await mount(
        <ShellApp theme={THEME} model={MODEL} onExit={() => {}} questions={f.presenter} />,
        SHAPE,
      );
      const frame = await shell.frame("protected input");
      expect(frame).not.toContain("Enter the signing key");
      await shell.type("secret");
      await shell.press("\r");
      expect(created.control.inspect()).toMatchObject({ ok: true, value: { settlement: null } });
      expect(await shell.frame()).not.toContain("secret");
      await shell.press("r", { ctrl: true });
      await shell.frame("Question refused.");
      const settled = await created.control.wait(signal);
      expect(settled.ok && settled.value).toMatchObject({ kind: "refused", answer: null });
    } finally {
      await f.dispose();
    }
  });

  test("a narrow, short terminal keeps the cursor and the keys visible", async () => {
    const f = await questionPresenterFixture();
    try {
      await f.ask({
        items: [
          {
            id: "choice",
            kind: "single-select",
            prompt: "Choose a region",
            options: Array.from({ length: 12 }, (_, index) => ({
              id: `r${index}`,
              label: `Region ${index}`,
            })),
          },
        ],
      });
      using shell = await mount(
        <ShellApp theme={THEME} model={MODEL} onExit={() => {}} questions={f.presenter} />,
        { shape: { columns: 48, rows: 16 } },
      );
      await shell.frame("Choose a region");
      for (let step = 0; step < 11; step++) await shell.press(DOWN);
      const frame = await shell.frame("› ( ) Region 11");
      expect(frame).toContain("ctrl+r");
    } finally {
      await f.dispose();
    }
  });
});
