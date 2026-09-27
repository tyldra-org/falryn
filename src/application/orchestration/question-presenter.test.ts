import { afterEach, expect, test } from "bun:test";
import { removeTemporaryRoots } from "../../data/fixtures.ts";
import { duration } from "../../domain/foundation/clock.ts";
import {
  chooseOption as choose,
  questionPresenterFixture as fixture,
  PRESENTER_PRINCIPAL as principal,
} from "./question-presenter.fixtures.ts";

afterEach(removeTemporaryRoots);
const signal = new AbortController().signal;

test("an offered question is presented, answered once and leaves the queue", async () => {
  const f = await fixture();
  try {
    const { created, offered } = await f.ask();
    expect(offered).toBe(true);
    const current = f.presenter.view().current;
    expect(current).toMatchObject({ source: "Workflow question", sensitivity: "normal" });
    expect(current?.items[0]?.kind).toBe("single-select");
    // Capabilities never reach the projection.
    expect(JSON.stringify(f.presenter.view())).not.toContain(created.presenterToken);
    expect(await f.presenter.answer(current?.key ?? "", choose("b"))).toEqual({
      ok: true,
      settlement: "answered",
    });
    expect(f.presenter.view()).toEqual({ current: null, queued: 0, left: 0 });
    const settled = await created.control.wait(signal);
    expect(settled.ok && settled.value).toMatchObject({
      kind: "answered",
      answer: choose("b"),
      effectAuthority: false,
    });
    // Each presenter action used its own short-lived resource scope.
    expect(f.scopes).toBe(2);
  } finally {
    await f.dispose();
  }
});

test("refusal settles the question as refused and an invalid answer changes nothing", async () => {
  const f = await fixture();
  try {
    const { created } = await f.ask();
    const key = f.presenter.view().current?.key ?? "";
    expect(await f.presenter.answer(key, choose("missing"))).toEqual({
      ok: false,
      code: "malformed",
    });
    expect(f.presenter.view().current?.key).toBe(key);
    expect(await f.presenter.refuse(key)).toEqual({ ok: true, settlement: "refused" });
    const settled = await created.control.wait(signal);
    expect(settled.ok && settled.value.kind).toBe("refused");
    expect(f.presenter.view().current).toBeNull();
  } finally {
    await f.dispose();
  }
});

test("questions queue in order, and a left question waits until reopened", async () => {
  const f = await fixture();
  try {
    const first = await f.ask();
    const second = await f.ask();
    expect(f.presenter.view()).toMatchObject({ queued: 1, left: 0 });
    const firstKey = f.presenter.view().current?.key ?? "";
    expect(await f.presenter.leave(firstKey)).toEqual({ ok: true, settlement: null });
    expect(f.presenter.view()).toMatchObject({ queued: 0, left: 1 });
    expect(f.presenter.view().current?.key).not.toBe(firstKey);
    expect(first.created.control.inspect()).toMatchObject({
      ok: true,
      value: { presenter: "disconnected", settlement: null },
    });
    expect(await f.presenter.answer(firstKey, choose("a"))).toEqual({
      ok: false,
      code: "not-presented",
    });
    const secondKey = f.presenter.view().current?.key ?? "";
    expect(await f.presenter.answer(secondKey, choose("a"))).toEqual({
      ok: true,
      settlement: "answered",
    });
    expect(f.presenter.view()).toEqual({ current: null, queued: 0, left: 1 });
    expect(await f.presenter.reopen()).toEqual({ ok: true, settlement: null });
    expect(f.presenter.view().current?.key).toBe(firstKey);
    expect(await f.presenter.answer(firstKey, choose("b"))).toEqual({
      ok: true,
      settlement: "answered",
    });
    const settled = await first.created.control.wait(signal);
    expect(settled.ok && settled.value.kind).toBe("answered");
    expect(second.offered).toBe(true);
    expect(await f.presenter.reopen()).toEqual({ ok: false, code: "nothing-left" });
  } finally {
    await f.dispose();
  }
});

test("owner cancellation and expiry remove a shown question without an answer", async () => {
  const f = await fixture();
  try {
    const cancelled = await f.ask();
    expect((await cancelled.created.control.cancel(signal)).ok).toBe(true);
    f.presenter.refresh();
    expect(f.presenter.view().current).toBeNull();

    const expiring = await f.ask({ waitMs: 1_000 });
    const key = f.presenter.view().current?.key ?? "";
    await f.clock.advance(duration(1_500));
    f.presenter.refresh();
    expect(f.presenter.view().current).toBeNull();
    expect(await f.presenter.answer(key, choose("a"))).toEqual({
      ok: false,
      code: "not-presented",
    });
    const settled = await expiring.created.control.wait(signal);
    expect(settled.ok && settled.value).toMatchObject({ kind: "expired", answer: null });

    // An answer submitted after the deadline, before the queue refreshes, is not an answer.
    const late = await f.ask({ waitMs: 1_000 });
    const lateKey = f.presenter.view().current?.key ?? "";
    await f.clock.advance(duration(1_500));
    // The service's deadline settled it first; the late answer conflicts and is not stored.
    expect(await f.presenter.answer(lateKey, choose("a"))).toEqual({
      ok: false,
      code: "conflicting-answer",
    });
    expect(f.presenter.view().current).toBeNull();
    const lateSettled = await late.created.control.wait(signal);
    expect(lateSettled.ok && lateSettled.value).toMatchObject({ kind: "expired", answer: null });
  } finally {
    await f.dispose();
  }
});

test("a closed presenter refuses offers and a duplicate offer is ignored", async () => {
  const f = await fixture();
  try {
    const { created } = await f.ask();
    expect(await f.presenter.offer(created, principal, "again")).toBe(false);
    expect(f.presenter.view()).toMatchObject({ queued: 0 });
    f.presenter.close();
    expect(f.presenter.view().current).toBeNull();
    expect(await f.presenter.offer(created, principal, "late")).toBe(false);
  } finally {
    await f.dispose();
  }
});
