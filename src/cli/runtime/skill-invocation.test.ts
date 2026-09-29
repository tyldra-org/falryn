import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      ["deploy", '"disable-model-invocation": true'],
      ["triage", '"user-invocable": false'],
    ] as const) {
      await mkdir(join(location, name), { recursive: true });
      await writeFile(
        join(location, name, "SKILL.md"),
        "---\nname: " +
          JSON.stringify(name) +
          '\ndescription: "Handle ' +
          name +
          '."\n' +
          frontmatter.replace(": ", ": ").replace(/^"([^"]+)": /u, "$1: ") +
          "\n---\nBODY_" +
          name +
          "\n",
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
      const listed =
        (await submission.listSkills?.(
          { filter: null, offset: 0 },
          new AbortController().signal,
        )) ?? [];
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
