import { afterAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillFindingsQuerySchema } from "../../domain/context/skill-findings.ts";
import { instructionProduct } from "../runtime/instruction-product.fixtures.ts";
import { runDoctor } from "./doctor.ts";
import { runExtensionCatalog } from "./extension-catalog.ts";
import { collectSkillFindings, DEFAULT_SKILL_FINDINGS_LOAD } from "./skill-findings.ts";

const homes: string[] = [];
afterAll(async () => {
  await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
});

async function skill(directory: string, name: string, front: string, body = "Body.") {
  await mkdir(join(directory, name), { recursive: true });
  await writeFile(join(directory, name, "SKILL.md"), `---\n${front}\n---\n${body}\n`);
}

/**
 * The completion-proof workspace: a valid skill, malformed frontmatter, a missing script,
 * an unregistered MCP tool, a same-named skill in another root and a shadowed user skill.
 * The malformed skill is a user skill: a malformed project SKILL.md fails the workspace
 * trust review itself, which the last test covers. A script and an MCP server each write
 * a marker if anything ever runs them.
 */
async function fixture(options: { readonly trusted?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), "falryn-skill-findings-"));
  homes.push(home);
  const other = join(home, "other");
  await mkdir(other, { recursive: true });
  const product = await instructionProduct(home, [other]);
  const skills = join(product.workspace, ".falryn", "skills");
  const userSkills = join(home, ".agents", "skills");
  const marker = join(home, "executed");
  await skill(
    skills,
    "valid-skill",
    "name: valid-skill\ndescription: Lint the repository",
    "Read [the guide](references/guide.md).",
  );
  await mkdir(join(skills, "valid-skill", "references"), { recursive: true });
  await writeFile(join(skills, "valid-skill", "references", "guide.md"), "Guide.");
  await skill(
    skills,
    "missing-script",
    "name: missing-script\ndescription: Run the release helper",
    "Run [the helper](scripts/run.sh) or [this one](scripts/exists.sh).",
  );
  await mkdir(join(skills, "missing-script", "scripts"), { recursive: true });
  const script = join(skills, "missing-script", "scripts", "exists.sh");
  await writeFile(script, `#!/bin/sh\ntouch "${marker}"\n`);
  await chmod(script, 0o755);
  await skill(
    skills,
    "needs-tool",
    "name: needs-tool\ndescription: Triage issues\nallowed-tools: Read mcp__github__get_issue mcp__jira__search",
  );
  await skill(
    join(other, ".falryn", "skills"),
    "valid-skill",
    "name: valid-skill\ndescription: Another root's copy",
  );
  await skill(userSkills, "valid-skill", "name: valid-skill\ndescription: The user's copy");
  await skill(userSkills, "broken-meta", "name: broken-meta");
  // A configured server whose start would leave the marker; checks never start it.
  await product.setting("tools.mcpConnections", {
    servers: [
      { id: "jira", transport: "stdio", executable: "/bin/sh", args: ["-c", `touch "${marker}"`] },
    ],
  });
  await product.services().ensureWorkspaceSet();
  if (options.trusted !== false) {
    const trust = await product.services().workspaceTrust.resolve(async () => "proceed");
    expect(trust.status).toBe("accepted");
  }
  return { ...product, home, skills, userSkills, marker };
}

const signal = () => new AbortController().signal;

test(
  "doctor counts and the catalog lists exactly the expected codes, sources and fixes, without running anything",
  async () => {
    const f = await fixture();
    const doctor = await runDoctor(f.services, f.globals, signal());
    const skills = doctor.payload?.skills;
    if (skills?.status !== "inspected") throw new Error(JSON.stringify(skills));
    expect([skills.counts, skills.skills, skills.omitted]).toEqual([
      { error: 1, warning: 2, info: 1 },
      6,
      0,
    ]);
    expect(skills.top.map((item) => [item.severity, item.code, item.skill.name])).toEqual([
      ["error", "metadata-invalid", "broken-meta"],
      ["warning", "reference-missing", "missing-script"],
      ["warning", "capability-unavailable", "needs-tool"],
      ["info", "shadowed", "valid-skill"],
    ]);
    // Doctor's verdict is about local data; a broken skill is a finding, not a failure.
    expect(doctor.outcome.kind).toBe("completed");

    const catalog = await runExtensionCatalog(
      f.services,
      { action: "catalog", skills: skillFindingsQuerySchema.parse({}) },
      signal(),
    );
    const page = catalog.payload?.status === "inspected" ? catalog.payload.skills : undefined;
    if (page?.status !== "inspected") throw new Error(JSON.stringify(catalog.payload));
    expect(page.complete).toBe(true);
    // Same-named copies in two roots differ only by source, so compare them by state.
    expect(
      page.entries
        .map((entry) => [
          entry.origin,
          entry.name,
          entry.state,
          entry.findings.map((item) => item.code),
        ])
        .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
    ).toEqual([
      ["project-falryn", "missing-script", "selected", ["reference-missing"]],
      ["project-falryn", "needs-tool", "selected", ["capability-unavailable"]],
      // Another root's same-named copy belongs to that root: excluded here, not a conflict.
      ["project-falryn", "valid-skill", "excluded", []],
      ["project-falryn", "valid-skill", "selected", []],
      ["user-agents", "broken-meta", "excluded", ["metadata-invalid"]],
      ["user-agents", "valid-skill", "shadowed", ["shadowed"]],
    ]);
    const findings = page.entries.flatMap((entry) => entry.findings);
    expect(findings.map((item) => [item.code, item.skill.path, item.evidence, item.fix])).toEqual([
      [
        "metadata-invalid",
        ".agents/skills/broken-meta/SKILL.md",
        { problem: "malformed-metadata", field: "description" },
        expect.stringContaining("description"),
      ],
      [
        "reference-missing",
        ".falryn/skills/missing-script/SKILL.md",
        { path: "scripts/run.sh", state: "missing" },
        "Add scripts/run.sh to the skill directory or correct the link.",
      ],
      [
        "capability-unavailable",
        ".falryn/skills/needs-tool/SKILL.md",
        { server: "github", field: "allowed-tools" },
        expect.stringContaining('Configure MCP server "github" in tools.mcpConnections'),
      ],
      [
        "shadowed",
        ".agents/skills/valid-skill/SKILL.md",
        expect.objectContaining({
          winnerOrigin: "project-falryn",
          winnerPath: ".falryn/skills/valid-skill/SKILL.md",
        }),
        "Rename this skill, or remove the higher-priority copy, to use it.",
      ],
    ]);
    expect(findings.every((item) => item.skill.digest?.startsWith("sha256:"))).toBe(true);
    // The Extensions view's application action and the CLI page are one projection of one generation.
    const direct = await collectSkillFindings(f.services, DEFAULT_SKILL_FINDINGS_LOAD, signal());
    if (direct.status !== "collected") throw new Error(direct.code);
    expect([direct.generation, direct.entries]).toEqual([page.generation, page.entries]);
    // Doctor loads configuration with the run's profile and overrides, so its generation is
    // its own; its findings are the same, most severe first.
    expect(skills.top).toEqual(findings);
    // No script ran and no MCP server started.
    expect(await stat(f.marker).catch(() => null)).toBeNull();
  },
  { timeout: 60_000 }, // Configuration loads, three discovery scans and usage reads over real files.
);

test(
  "default checks read only the published entrypoints; fixing a file clears its finding on the next generation, also after restart",
  async () => {
    const f = await fixture();
    await collectSkillFindings(f.services, DEFAULT_SKILL_FINDINGS_LOAD, signal());
    // Count reads from here on. Discovery reads through readBytesRange; the workspace trust
    // review re-hashes reviewed project files through readBytes when configuration loads.
    const fileSystem = f.services().fileSystem as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    const reads: { readonly method: string; readonly path: string }[] = [];
    for (const method of ["readBytesRange", "readBytes"]) {
      const original = fileSystem[method]?.bind(fileSystem);
      if (original === undefined) throw new Error(method);
      fileSystem[method] = (...args: unknown[]) => {
        reads.push({ method, path: String(args[0]) });
        return original(...args);
      };
    }
    const first = await collectSkillFindings(f.services, DEFAULT_SKILL_FINDINGS_LOAD, signal());
    if (first.status !== "collected") throw new Error(first.code);
    const discovery = reads
      .filter((read) => read.method === "readBytesRange" && read.path.includes("/skills/"))
      .map((read) => read.path);
    // Discovery reads each entrypoint once; findings add no read: links are checked with
    // stat, so the files they name are never read by this path.
    expect(discovery.every((path) => path.endsWith("/SKILL.md"))).toBe(true);
    expect(discovery.length).toBe(new Set(discovery).size);
    expect(discovery.length).toBe(6);
    expect(
      reads.some(
        (read) =>
          read.method === "readBytesRange" &&
          (read.path.endsWith("references/guide.md") || read.path.endsWith("scripts/exists.sh")),
      ),
    ).toBe(false);

    await writeFile(
      join(f.userSkills, "broken-meta", "SKILL.md"),
      "---\nname: broken-meta\ndescription: Fixed now\n---\nBody.\n",
    );
    const fixed = await collectSkillFindings(f.services, DEFAULT_SKILL_FINDINGS_LOAD, signal());
    if (fixed.status !== "collected") throw new Error(fixed.code);
    expect(fixed.generation).not.toBe(first.generation);
    expect(fixed.entries.find((entry) => entry.name === "broken-meta")?.findings).toEqual([]);

    // A new process derives the same findings from the same files.
    const restarted = await instructionProduct(f.home, [join(f.home, "other")]);
    await restarted.services().ensureWorkspaceSet();
    await restarted.services().workspaceTrust.resolve(async () => "proceed");
    const again = await collectSkillFindings(
      restarted.services,
      DEFAULT_SKILL_FINDINGS_LOAD,
      signal(),
    );
    if (again.status !== "collected") throw new Error(again.code);
    expect([again.generation, again.entries]).toEqual([fixed.generation, fixed.entries]);
  },
  { timeout: 60_000 }, // Four discovery scans over real files and a second product graph.
);

test(
  "an untrusted workspace and a malformed project skill explain why project skills cannot load",
  async () => {
    const f = await fixture({ trusted: false });
    // A malformed project SKILL.md fails the trust review itself.
    await skill(f.skills, "broken-project", "name: broken-project");
    const trust = await f.services().workspaceTrust.resolve(async () => "proceed");
    expect([trust.status, trust.reason]).toEqual(["failed", "inventory-malformed"]);
    const collected = await collectSkillFindings(f.services, DEFAULT_SKILL_FINDINGS_LOAD, signal());
    if (collected.status !== "collected") throw new Error(collected.code);
    const project = collected.entries.filter((entry) => entry.origin === "project-falryn");
    expect(project.map((entry) => entry.name)).toEqual([
      "broken-project",
      "missing-script",
      "needs-tool",
      "valid-skill",
      "valid-skill",
    ]);
    for (const entry of project)
      expect(entry.findings).toEqual([
        expect.objectContaining({
          code: "activation-failed",
          evidence: {
            reason: "workspace-untrusted",
            trustStatus: "failed",
            trustReason: "inventory-malformed",
          },
          fix: expect.stringContaining("falryn extension inspect"),
        }),
      ]);
    // Untrusted project skills are never read, so none has a digest.
    expect(project.every((entry) => entry.digest === null)).toBe(true);
  },
  { timeout: 60_000 }, // A trust review and a discovery scan over real files.
);
