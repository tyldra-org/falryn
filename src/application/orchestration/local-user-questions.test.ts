import { expect, test } from "bun:test";
import { duration } from "../../domain/foundation/clock.ts";
import { createLocalUserQuestions } from "./local-user-questions.ts";
import {
  chooseOption,
  PRESENTER_PRINCIPAL,
  questionPresenterFixture,
} from "./question-presenter.fixtures.ts";

const ITEMS = [
  {
    id: "choice",
    kind: "single-select" as const,
    prompt: "Which branch?",
    options: [
      { id: "a", label: "main" },
      { id: "b", label: "next" },
    ],
  },
];

async function fixture() {
  const f = await questionPresenterFixture();
  const local = createLocalUserQuestions({
    questions: f.questions,
    presenter: f.presenter,
    principal: PRESENTER_PRINCIPAL,
  });
  const ask = (signal = new AbortController().signal, waitMs = 60_000) =>
    local.ask({
      owner: f.owner,
      resources: f.budget,
      items: ITEMS,
      waitMs,
      source: "fixture · tool",
      signal,
    });
  /** Resolves once the presenter shows a question. */
  const shown = () =>
    new Promise<string>((resolve) => {
      const check = () => {
        const current = f.presenter.view().current;
        if (current) resolve(current.key);
      };
      f.presenter.subscribe(check);
      check();
    });
  return { f, ask, shown };
}

test("a question offered to the local presenter settles with the user's answer", async () => {
  const { f, ask, shown } = await fixture();
  try {
    const pending = ask();
    const key = await shown();
    expect(f.presenter.view().current).toMatchObject({ source: "fixture · tool" });
    expect(await f.presenter.answer(key, chooseOption("b"))).toMatchObject({ ok: true });
    expect(await pending).toEqual({ kind: "answered", answer: chooseOption("b") });
  } finally {
    await f.dispose();
  }
});

test("refusal and expiry settle without an answer", async () => {
  const { f, ask, shown } = await fixture();
  try {
    const refused = ask();
    await f.presenter.refuse(await shown());
    expect(await refused).toEqual({ kind: "refused" });
    const expiring = ask(undefined, 1_000);
    await shown();
    await f.clock.advance(duration(1_500));
    expect(await expiring).toEqual({ kind: "expired" });
  } finally {
    await f.dispose();
  }
});

test("an abandoned wait cancels the question and withdraws it from the presenter", async () => {
  const { f, ask, shown } = await fixture();
  try {
    const abort = new AbortController();
    const pending = ask(abort.signal);
    await shown();
    abort.abort();
    expect(await pending).toEqual({ kind: "cancelled" });
    expect(f.presenter.view().current).toBeNull();
  } finally {
    await f.dispose();
  }
});

test("a presenter that cannot take the question leaves nothing waiting", async () => {
  const { f, ask } = await fixture();
  try {
    f.presenter.close();
    expect(await ask()).toEqual({ kind: "unavailable" });
  } finally {
    await f.dispose();
  }
});
