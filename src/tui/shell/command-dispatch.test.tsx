/**
 * One dispatcher for slash text, the palette and keys (#790).
 *
 * Each case drives the mounted shell the way a user does — typing in the
 * composer or searching the palette — and observes the action owner, the notice
 * and the draft, so equivalence and refusals are proved through the real path.
 */

import { describe, expect, test } from "bun:test";
import {
  createInterruptionPolicy,
  createMidTurnInputService,
  createTurnCoordinator,
} from "../../application/runtime/index.ts";
import {
  configurationGeneration,
  createManualClock,
  followUpId,
  modelAttemptId,
  sessionId,
  traceId,
  turnId,
  workspaceId,
} from "../../domain/foundation/index.ts";
import { type SubmissionPort, UNAVAILABLE_SUBMISSION } from "../composer/index.ts";
import { mount, type Rendered } from "../runtime/harness.tsx";
import { ShellApp } from "./shell-app.tsx";
import { exitConfirmationNotice } from "./shell-runtime.tsx";
import { known, type ShellModel, unavailable } from "./view-model.ts";

const THEME = {
  variant: "dark",
  colorLevel: "truecolor",
  symbols: "unicode",
  reducedMotion: true,
  generation: 1,
} as const;

const MODEL: Omit<ShellModel, "overlay" | "commands" | "transcript" | "composer" | "activity"> = {
  header: {
    workspace: known("/work/falryn"),
    branch: unavailable("no Git yet"),
    session: known("alice"),
    model: unavailable("no provider yet"),
  },
  status: { status: "informational", message: "Ready", hints: [] },
  help: [],
};

const generation = configurationGeneration.from(0);

/** A mid-turn service whose turn is awaiting the model, so a turn is active. */
function activeMidTurn() {
  const coordinator = createTurnCoordinator();
  const service = createMidTurnInputService({
    sessionId: sessionId.from("session-1"),
    coordinator,
    interruption: createInterruptionPolicy(createManualClock()),
    nextFollowUpId: () => followUpId.from("fu-1"),
  });
  coordinator.start({
    turnId: turnId.from("turn-1"),
    sessionId: sessionId.from("session-1"),
    workspaceId: workspaceId.from("workspace-1"),
    traceId: traceId.from("trace-1"),
    configurationGeneration: generation,
  });
  for (const command of [
    "begin-orienting",
    "begin-assembling-context",
    "begin-awaiting-model",
  ] as const) {
    coordinator.apply({
      turnId: turnId.from("turn-1"),
      command,
      configurationGeneration: generation,
    });
  }
  service.syncFromTurn(coordinator.get(turnId.from("turn-1")));
  service.setActiveAttempt(modelAttemptId.from("attempt-1"));
  return service;
}

type Probe = {
  /** When set, mode selection fails with this message instead of applying. */
  failSelect?: string;
  readonly selected: string[];
  readonly peers: unknown[];
  readonly skillPages: unknown[];
  turns: number;
  exits: number;
};

function probedSubmission(probe: Probe): SubmissionPort & {
  readonly executionProfile: {
    get(): string;
    select(id: string): Promise<{ ok: true; profileId: string; changed: boolean }>;
  };
} {
  return {
    ...UNAVAILABLE_SUBMISSION,
    submit(snapshot) {
      probe.turns += 1;
      return { kind: "accepted", snapshot };
    },
    async peer(input) {
      probe.peers.push(input);
      return { ok: true };
    },
    async listSkills(page) {
      probe.skillPages.push(page);
      return ["review — Review a diff"];
    },
    // `goal` is also a user skill here, so the planned `/goal` must yield to it.
    skillCandidates: () => ({ invocable: new Set(["goal"]), templates: new Set<string>() }),
    skillCommand: (text) =>
      /^\/goal(?:\s|$)/u.test(text.trim())
        ? { kind: "skill", name: "goal", qualified: false }
        : null,
    executionProfile: {
      get: () => probe.selected.at(-1) ?? "agent",
      async select(id) {
        if (probe.failSelect !== undefined)
          return { ok: false, message: probe.failSelect } as unknown as {
            ok: true;
            profileId: string;
            changed: boolean;
          };
        const changed = id !== (probe.selected.at(-1) ?? "agent");
        probe.selected.push(id);
        return { ok: true, profileId: id, changed };
      },
    },
  };
}

async function open(options: { readonly activeTurn?: boolean; readonly failSelect?: string } = {}) {
  const probe: Probe = {
    selected: [],
    peers: [],
    skillPages: [],
    turns: 0,
    exits: 0,
    ...(options.failSelect === undefined ? {} : { failSelect: options.failSelect }),
  };
  const shell = await mount(
    <ShellApp
      theme={THEME}
      model={MODEL}
      onExit={() => {
        probe.exits += 1;
      }}
      submission={probedSubmission(probe)}
      controls={{
        sessions: [],
        models: [],
        profiles: [{ id: "plan", title: "Plan", detail: "Read-only plan" }],
        context: [],
        resources: [],
      }}
      {...(options.activeTurn === true ? { midTurn: activeMidTurn() } : {})}
    />,
    { shape: { columns: 140, rows: 30 } },
  );
  await shell.frame();
  return Object.assign(shell, { probe });
}

/** Focus the composer, type, and press Return. */
async function slash(shell: Rendered, text: string): Promise<string> {
  await shell.press("\t");
  await shell.press("\t");
  await shell.type(text);
  return shell.press("\r");
}

async function palette(shell: Rendered, query: string): Promise<void> {
  await shell.press("p", { ctrl: true });
  await shell.frame("Commands");
  await shell.type(query);
  shell.setup.mockInput.pressEnter();
}

describe("one dispatcher for every caller", () => {
  test("a canonical form, a direct alias and its argument reach the same action once", async () => {
    using shell = await open();
    await slash(shell, "/mode PLAN");
    expect(await shell.frame("Execution mode set to plan")).toContain("Execution mode set to plan");
    // The composer keeps focus after a command; type the next one directly.
    await shell.type("/debug");
    await shell.press("\r");
    expect(await shell.frame("Execution mode set to debug")).toContain("set to debug");
    expect(shell.probe.selected).toEqual(["plan", "debug"]);
    expect(shell.probe.turns).toBe(0);
  });

  test("the bare command opens the same picker from slash text and the palette", async () => {
    using shell = await open();
    await slash(shell, "/mode");
    expect(await shell.frame("Execution modes")).toContain("[agent]");
    await shell.pressEscape();
    await palette(shell, "mode.select");
    expect(await shell.frame("Execution modes")).toContain("Execution modes");
    expect(shell.probe.selected).toEqual([]);
  });

  test("slash text clears the draft once its command is dispatched", async () => {
    using shell = await open();
    const frame = await slash(shell, "/peer");
    expect(shell.probe.peers).toEqual([{ operation: "endpoint" }]);
    expect(frame).not.toContain("/peer");
  });

  test("/skills reaches the catalog through the registry with its filter and page", async () => {
    using shell = await open();
    await slash(shell, "/skills rev after 20");
    expect(await shell.frame("review — Review a diff")).toContain("review — Review a diff");
    expect(shell.probe.skillPages).toEqual([{ filter: "rev", offset: 20 }]);
  });
});

describe("refusals keep the draft and run nothing", () => {
  test("a planned command names its owning issue", async () => {
    using shell = await open();
    const frame = await slash(shell, "/tools");
    expect(frame).toContain("/tools is not available yet");
    expect(frame).toContain("#192");
    expect(frame).toContain("/tools");
    expect(shell.probe.turns).toBe(0);
  });

  test("an invalid argument is refused by the registry with the real choices", async () => {
    using shell = await open();
    const frame = await slash(shell, "/mode fast");
    expect(frame).toContain("Unsupported value “fast” for /mode. Use /mode ask|plan|debug|agent.");
    expect(frame).toContain("/mode fast");
    expect(shell.probe.selected).toEqual([]);
    expect(shell.probe.turns).toBe(0);
  });

  test("an asynchronous action that fails keeps the draft", async () => {
    using shell = await open({ failSelect: "the profile could not be saved" });
    await slash(shell, "/mode plan");
    const frame = await shell.frame("the profile could not be saved");
    expect(frame).toContain("/mode plan");
    expect(shell.probe.selected).toEqual([]);
  });

  test("a planned command yields to a skill of the same name", async () => {
    using shell = await open();
    await slash(shell, "/goal ship it");
    await shell.frame();
    expect(shell.probe.turns).toBe(1);
  });

  test("a planned command found in the palette is refused the same way", async () => {
    using shell = await open();
    await palette(shell, "goal.control");
    expect(await shell.frame("#797")).toContain("/goal is not available yet");
  });

  test("unclaimed slash text still goes to the composer's other owners", async () => {
    using shell = await open();
    await slash(shell, "/review this diff");
    await shell.frame();
    expect(shell.probe.turns).toBe(1);
  });
});

describe("timing during an active turn", () => {
  test("a safe-point change is refused and never runs early", async () => {
    using shell = await open({ activeTurn: true });
    const frame = await slash(shell, "/plan");
    expect(frame).toContain("/mode changes state the running turn uses");
    expect(shell.probe.selected).toEqual([]);
    expect(frame).toContain("/plan");
  });

  test("a picker cannot apply what the command form refuses during a turn", async () => {
    using shell = await open({ activeTurn: true });
    await palette(shell, "mode.select");
    await shell.frame("Execution modes");
    shell.setup.mockInput.pressEnter();
    expect(await shell.frame("changes state the running turn uses")).toContain(
      "/mode changes state the running turn uses",
    );
    expect(shell.probe.selected).toEqual([]);
  });

  test("an immediate command still runs without waiting", async () => {
    using shell = await open({ activeTurn: true });
    await slash(shell, "/help");
    expect(await shell.frame("Help")).toContain("Help");
  });

  test("/quit names the running turn before it leaves, and a second /quit leaves", async () => {
    using shell = await open({ activeTurn: true });
    const armed = await slash(shell, "/quit");
    expect(armed).toContain("Press Ctrl+C again to exit. Leaving cancels the running turn.");
    expect(shell.probe.exits).toBe(0);
    await shell.type("/quit");
    await shell.press("\r");
    expect(shell.probe.exits).toBe(1);
  });
});

describe("exitConfirmationNotice", () => {
  test("keeps the plain notice when nothing is pending and lists what leaving ends", () => {
    const none = { turn: false, confirmation: false, background: false, draft: false };
    expect(exitConfirmationNotice(none)).toBe("Press Ctrl+C again to exit.");
    expect(exitConfirmationNotice({ ...none, draft: true })).toBe(
      "Press Ctrl+C again to exit. Leaving discards the unsent draft.",
    );
    expect(
      exitConfirmationNotice({ turn: true, confirmation: true, background: true, draft: true }),
    ).toBe(
      "Press Ctrl+C again to exit. Leaving cancels the running turn, declines the waiting confirmation and discards the unsent draft.",
    );
    expect(exitConfirmationNotice({ ...none, background: true })).toBe(
      "Press Ctrl+C again to exit. Leaving stops waiting for running work.",
    );
  });
});
