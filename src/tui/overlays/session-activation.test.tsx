import { expect, test } from "bun:test";
import { createActivationFixture } from "../../cli/runtime/session-activation.fixtures.ts";
import { mount } from "../runtime/harness.tsx";
import { ShellApp } from "../shell/shell-app.tsx";
import { known, unavailable } from "../shell/view-model.ts";
import { useTranscriptProjection } from "../transcript/transcript-feed.ts";

test("real resume overlay changes header and next submission together, retaining the typed draft", async () => {
  const cleanups: (() => Promise<unknown>)[] = [];
  await using _cleanup = {
    async [Symbol.asyncDispose]() {
      for (const close of cleanups.reverse()) await close();
    },
  };
  const t = await createActivationFixture((close) => cleanups.push(close));
  await t.send("VISIBLE_A_SOURCE");
  const a = t.currentId();
  await t.attached.sessionCreation.create();
  await t.send("VISIBLE_B_SOURCE");
  const list = await t.nav.listSessions();
  if (!list.ok) throw new Error("navigation unavailable");
  const index = list.value.findIndex((entry) => entry.sessionId === a);
  expect(index).toBeGreaterThanOrEqual(0);
  function ProductShell() {
    const transcript = useTranscriptProjection(t.attached.transcriptFeed);
    return (
      <ShellApp
        theme={{
          variant: "dark",
          colorLevel: "truecolor",
          symbols: "unicode",
          reducedMotion: true,
          generation: 1,
        }}
        model={{
          header: {
            workspace: known("fixture"),
            branch: unavailable("none"),
            session: unavailable("none"),
            model: unavailable("none"),
          },
          status: { status: "informational", message: "Ready", hints: [] },
          help: [],
        }}
        onExit={() => {}}
        transcript={transcript}
        submission={t.attached.submission}
        controls={t.attached.controls}
        sessionNavigationController={t.nav}
        sessionCreation={t.attached.sessionCreation}
      />
    );
  }
  using shell = await mount(<ProductShell />, { shape: { columns: 160, rows: 40 } });
  await shell.frame();
  await shell.press("\t");
  await shell.press("\t");
  await shell.type("DRAFT_FOR_SELECTED_A");
  await shell.press("p", { ctrl: true });
  await shell.frame("Commands");
  await shell.type("session.resume");
  await shell.press("\r");
  await shell.frame("Resume session");
  for (let n = 0; n < index; n++) await shell.press("\u001b[B");
  await shell.press("\r");
  const frame = await shell.frame();
  expect(frame).toContain(a);
  expect(frame).toContain("DRAFT_FOR_SELECTED_A");
  expect(t.attached.controls.activeSessionId).toBe(a);
  // Return to the composer and submit the preserved draft.
  await shell.press("\t");
  await shell.press("\t");
  await shell.press("\r");
  await shell.frame();
  expect(JSON.stringify(t.requests.at(-1)?.messages)).toContain("DRAFT_FOR_SELECTED_A");
  expect(JSON.stringify(t.requests.at(-1)?.messages)).toContain("VISIBLE_A_SOURCE");
  expect(JSON.stringify(t.requests.at(-1)?.messages)).not.toContain("VISIBLE_B_SOURCE");
});
