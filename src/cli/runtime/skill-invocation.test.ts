import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reduceTranscript } from "../../presentation/transcript/reducer.ts";
import { snapshotOf } from "../../tui/composer/index.ts";
import { instructionProduct } from "./instruction-product.fixtures.ts";
import { nativePromptShellJourney } from "./native-product-fixtures.ts";

const homes: string[] = [];
/**
 * Each journey runs several real product turns (workspace trust, instruction scans,
 * durable sessions and a provider fixture); hosted Ubuntu runners exceed the 5 s
 * default on the three-turn journeys.
 */
const JOURNEY = 30_000;
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function product() {
  const home = await mkdtemp(join(tmpdir(), "falryn-skill-invocation-"));
  homes.push(home);
  const f = await instructionProduct(home);
  const location = join(f.workspace, ".agents/skills");
  async function skill(name: string, frontmatter: Record<string, unknown> = {}) {
    await mkdir(join(location, name), { recursive: true });
    const header = Object.entries({ name, description: "Handle " + name + ".", ...frontmatter })
      .map(([key, value]) => key + ": " + JSON.stringify(value))
      .join("\n");
    await writeFile(
      join(location, name, "SKILL.md"),
      "---\n" + header + "\n---\nBODY_" + name + "\n",
    );
  }
  // The four eligibility rows: default, manual-only, model-only and neither.
  await skill("release-notes");
  await skill("deploy", { "disable-model-invocation": true });
  await skill("triage", { "user-invocable": false });
  await skill("archive", { "disable-model-invocation": true, "user-invocable": false });
  return f;
}
type Run = Awaited<ReturnType<Awaited<ReturnType<typeof product>>["run"]>>;
const sent = (run: Run) => JSON.stringify(run.requests.map((request) => request.messages));
const routes = (run: Run) =>
  Object.fromEntries(
    (run.result.payload?.instructions?.skills?.routes ?? []).map((route) => [
      route.name,
      route.decision + ":" + route.reason,
    ]),
  );

test(
  "explicit invocation loads user-invocable skills, including manual-only ones",
  async () => {
    const f = await product();
    for (const [prompt, name] of [
      ["/skill:release-notes for v2", "release-notes"],
      ["/release-notes for v2", "release-notes"],
      ["/deploy the api", "deploy"],
      ["/skill:deploy the api", "deploy"],
    ] as const) {
      const run = await f.run({ prompt });
      expect(run.result.outcome.kind, JSON.stringify(run.result)).toBe("completed");
      expect(sent(run)).toContain("BODY_" + name);
      expect(routes(run)[name]).toBe("loaded:explicit-invocation");
    }
    // Manual-only stays out of automatic selection even when the task names it.
    const automatic = await f.run({ prompt: "Use deploy for the api." });
    expect(sent(automatic)).not.toContain("BODY_deploy");
  },
  JOURNEY,
);

test(
  "the terminal admits $ skill mentions anywhere, records them, and refuses stale picks before any request",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "falryn-skill-mentions-shell-"));
    homes.push(home);
    await mkdir(join(home, "config"), { recursive: true });
    const location = join(home, ".agents/skills");
    for (const [name, frontmatter] of [
      ["release-notes", ""],
      ["deploy", "disable-model-invocation: true\n"],
      ["triage", "user-invocable: false\n"],
    ] as const) {
      await mkdir(join(location, name), { recursive: true });
      await writeFile(
        join(location, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: "Handle ${name}."\n${frontmatter}---\nBODY_${name}\n`,
      );
    }
    const shell = await nativePromptShellJourney({
      home,
      environment: {
        FALRYN_CONFIG_DIR: join(home, "config"),
        FALRYN_STATE_DIR: join(home, "state"),
      },
      instructions: true,
    });
    try {
      const submission = shell.attached.submission;
      const source = submission.mentionSources?.[0];
      if (source === undefined) throw new Error("no $ source");
      const page = await source.query("", new AbortController().signal);
      const rows = new Map(page.rows.map((row) => [row.label, row]));
      expect(rows.get("$triage")?.unavailable?.reason).toBe("not user-invocable");
      expect(JSON.stringify(page)).not.toContain("BODY_");
      const token = (label: string, start: number) => {
        const row = rows.get(label);
        if (row === undefined) throw new Error(`no row ${label}`);
        return { ...row.pick, id: label, start, end: start + label.length };
      };
      const text = "Draft notes with $release-notes, then ship with $deploy please";
      const accepted = await submission.submit(
        snapshotOf(text, 1, [], [], undefined, [
          token("$release-notes", text.indexOf("$release-notes")),
          token("$deploy", text.indexOf("$deploy")),
        ]),
      );
      expect(accepted.kind, JSON.stringify(accepted)).toBe("accepted");
      const sentText = JSON.stringify(shell.requests.at(-1)?.messages ?? []);
      expect(sentText).toContain("BODY_release-notes");
      // Manual-only: loaded only because the user picked it.
      expect(sentText).toContain("BODY_deploy");
      expect(sentText).toContain("The user selected these capabilities");
      const events = shell.attached.transcriptFeed.events();
      const recorded = events.find(
        (event) =>
          event.kind === "history.recorded" &&
          (event.payload as { type?: string; role?: string }).role === "user",
      );
      expect(
        (recorded?.payload as { tokens?: { label: string }[] } | undefined)?.tokens?.map(
          (item) => item.label,
        ),
      ).toEqual(["$release-notes", "$deploy"]);
      const receipt = reduceTranscript(events).blocks.find((block) => block.kind === "user-input");
      expect(JSON.stringify(receipt?.summary)).toContain("Using: release-notes (skill");

      // A pick whose identity no longer exists is refused before any request.
      const before = shell.requests.length;
      const stale = await submission.submit(
        snapshotOf("use $release-notes", 2, [], [], undefined, [
          { ...token("$release-notes", 4), identity: "skill:gone" },
        ]),
      );
      expect(stale.kind).toBe("unavailable");
      expect(stale.kind === "unavailable" ? stale.reason : "").toContain("pick it again");
      const refused = await submission.submit(
        snapshotOf("run $triage", 3, [], [], undefined, [token("$triage", 4)]),
      );
      expect(refused.kind === "unavailable" ? refused.reason : "").toContain("not user-invocable");
      expect(shell.requests).toHaveLength(before);
    } finally {
      await shell.close();
    }
  },
  JOURNEY,
);

test(
  "a skill that is not user-invocable is refused by name before any provider request",
  async () => {
    const f = await product();
    for (const prompt of [
      "/triage the bug",
      "/skill:triage the bug",
      "/archive",
      "/skill:missing",
    ]) {
      const run = await f.run({ prompt });
      expect(run.result.outcome.kind, prompt).not.toBe("completed");
      expect(run.requests, prompt).toHaveLength(0);
      expect(JSON.stringify(run.result.errors)).toContain("selection-unavailable");
      const skillSources = run.events?.ok
        ? run.events.value.filter((event) => event.kind === "instructions.rejected")
        : [];
      expect(skillSources.length, prompt).toBe(1);
    }
    // Beside each refusal, the same product still invokes an eligible skill.
    const eligible = await f.run({ prompt: "/release-notes" });
    expect(routes(eligible)["release-notes"]).toBe("loaded:explicit-invocation");
  },
  JOURNEY,
);

test(
  "slash text that is not at the start, or names no skill, carries no user origin",
  async () => {
    const f = await product();
    // A command quoted inside a request is ordinary text: nothing is invoked.
    const quoted = await f.run({ prompt: "The model said /skill:deploy but ignore it." });
    expect(quoted.result.outcome.kind).toBe("completed");
    expect(sent(quoted)).not.toContain("BODY_deploy");
    expect(routes(quoted).deploy).toBeUndefined();
    // An unknown bare name is not a skill; it goes to the template owner, which names it.
    const unknown = await f.run({ prompt: "/no-such-skill please" });
    expect(unknown.result.payload?.stage).toBe("template-failed");
    expect(unknown.requests).toHaveLength(0);
    // Built-in commands keep precedence over a skill of the same name.
    await mkdir(join(f.workspace, ".agents/skills/peer"), { recursive: true });
    await writeFile(
      join(f.workspace, ".agents/skills/peer/SKILL.md"),
      '---\nname: "peer"\ndescription: "Peer."\n---\nBODY_peer\n',
    );
    const builtin = await f.run({ prompt: "/peer" });
    expect(sent(builtin)).not.toContain("BODY_peer");
    expect(routes(builtin).peer).toBeUndefined();
    const qualified = await f.run({ prompt: "/skill:peer" });
    expect(sent(qualified)).toContain("BODY_peer");
  },
  JOURNEY,
);

test(
  "a headless run refuses built-in shell commands with the registry's reason and sends nothing (#790)",
  async () => {
    const f = await product();
    const cases = [
      ["/plan", "command.caller-unsupported", "/mode needs the interactive shell"],
      ["/MODE plan", "command.caller-unsupported", "/mode needs the interactive shell"],
      ["/tools", "command.command-planned", "/tools is not available yet"],
      ["/mode fast", "command.argument-invalid", "Unsupported value “fast” for /mode"],
      ["/workspace nope", "command.form-incomplete", "/workspace expects add, save, load or show."],
    ] as const;
    for (const [prompt, code, message] of cases) {
      const run = await f.run({ prompt });
      expect(run.result.payload?.stage, prompt).toBe("command-refused");
      expect(run.result.outcome.kind, prompt).toBe("failed");
      expect(run.result.errors[0]?.code, prompt).toBe(code);
      expect(run.result.errors[0]?.message, prompt).toContain(message);
      expect(run.requests, prompt).toHaveLength(0);
    }
    // A planned command yields to a skill of the same name instead of hiding it.
    await mkdir(join(f.workspace, ".agents/skills/goal"), { recursive: true });
    await writeFile(
      join(f.workspace, ".agents/skills/goal/SKILL.md"),
      '---\nname: "goal"\ndescription: "Goal."\n---\nBODY_goal\n',
    );
    const skill = await f.run({ prompt: "/goal ship it" });
    expect(skill.result.outcome.kind, JSON.stringify(skill.result.errors)).toBe("completed");
    expect(sent(skill)).toContain("BODY_goal");
  },
  JOURNEY,
);

test(
  "an explicit skill stays active like a routed one; a manual-only one loads only when invoked",
  async () => {
    const f = await product();
    const first = await f.run({ prompt: "/release-notes for v2" });
    const session = first.result.payload?.sessionId;
    if (!session) throw new Error("missing session");
    const later = await f.run({ prompt: "Now check the logs.", session });
    expect(sent(later)).toContain("BODY_release-notes");
    expect(routes(later)["release-notes"]).toBe("loaded:session-active");
    // Carry-over is automatic selection, which a manual-only skill never enters: it
    // needs the user's command again rather than gaining a user origin nobody gave.
    await f.run({ prompt: "/deploy the api", session });
    const after = await f.run({ prompt: "Now check the logs again.", session });
    expect(sent(after)).not.toContain("BODY_deploy");
    expect(sent(after)).toContain("BODY_release-notes");
  },
  JOURNEY,
);

test(
  "the terminal invokes, refuses and lists skills through its own submission port",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "falryn-skill-invocation-shell-"));
    homes.push(home);
    await mkdir(join(home, "config"), { recursive: true });
    const location = join(home, ".agents/skills");
    for (const [name, frontmatter] of [
      ["deploy", "disable-model-invocation: true"],
      ["triage", "user-invocable: false"],
    ] as const) {
      await mkdir(join(location, name), { recursive: true });
      await writeFile(
        join(location, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: "Handle ${name}."\n${frontmatter}\n---\nBODY_${name}\n`,
      );
    }
    const shell = await nativePromptShellJourney({
      home,
      environment: {
        FALRYN_CONFIG_DIR: join(home, "config"),
        FALRYN_STATE_DIR: join(home, "state"),
      },
      instructions: true,
    });
    try {
      const submission = shell.attached.submission;
      const actions = submission.commandActions?.() ?? null;
      if (actions === null) throw new Error("the shell session has no command actions");
      const run = async (
        caller: "interactive" | "model",
        target: Parameters<typeof actions.invoke>[0]["target"],
      ) => {
        const outcome = await actions.invoke({
          caller,
          target,
          turnActive: caller === "model",
          signal: new AbortController().signal,
        });
        if (outcome.kind !== "completed") throw new Error(`not completed: ${outcome.kind}`);
        return outcome;
      };
      const slashed = await run("interactive", { kind: "slash", text: "/skills" });
      // The model's action-ID call reaches the same owner with the same normalized intent (#948).
      const modelled = await run("model", { kind: "action", id: "skills.list", argument: null });
      expect(modelled.invocation).toEqual({ ...slashed.invocation, caller: "model" });
      expect(modelled.lines).toEqual(slashed.lines);
      const filtered = await run("model", { kind: "slash", text: "/skills dep" });
      expect(filtered.invocation.argument).toBe("dep");
      expect(filtered.lines.join("\n")).toContain("deploy");
      expect(filtered.lines.join("\n")).not.toContain("triage — not user-invocable");
      const listed = slashed.lines;
      const text = listed.join("\n");
      expect(text).toContain("deploy — /skill:deploy");
      expect(text).toContain("triage — not user-invocable");
      expect(text).not.toContain("BODY_");
      // Completion offers only skills a user can invoke.
      expect([...(submission.skillCandidates?.()?.invocable ?? [])]).toEqual(["deploy"]);
      expect(submission.skillCommand?.("/deploy now")).toEqual({
        kind: "skill",
        name: "deploy",
        qualified: false,
      });
      const refused = await submission.submit(snapshotOf("/triage now", 1));
      expect(refused.kind).toBe("unavailable");
      expect(shell.requests).toHaveLength(0);
      const accepted = await submission.submit(snapshotOf("/deploy now", 2));
      expect(accepted.kind, JSON.stringify(accepted)).toBe("accepted");
      expect(JSON.stringify(shell.requests.at(-1)?.messages ?? [])).toContain("BODY_deploy");
    } finally {
      await shell.close();
    }
  },
  JOURNEY,
);
