import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativePromptShellJourney } from "./native-product-fixtures.ts";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

test("/skills shows the same findings and names earlier ones stale after a reload", async () => {
  const home = await mkdtemp(join(tmpdir(), "falryn-skill-findings-shell-"));
  homes.push(home);
  await mkdir(join(home, "config"), { recursive: true });
  const location = join(home, ".agents/skills");
  const write = async (name: string, text: string) => {
    await mkdir(join(location, name), { recursive: true });
    await writeFile(join(location, name, "SKILL.md"), text);
  };
  await write("broken", "---\nname: broken\n---\nBODY_broken\n");
  await write("linked", "---\nname: linked\ndescription: Linked\n---\nSee [x](references/x.md).\n");
  const shell = await nativePromptShellJourney({
    home,
    environment: { FALRYN_CONFIG_DIR: join(home, "config"), FALRYN_STATE_DIR: join(home, "state") },
    instructions: true,
  });
  try {
    const list = async () => {
      const listed = await shell.attached.submission.commandActions?.()?.invoke({
        caller: "interactive",
        target: { kind: "slash", text: "/skills" },
        turnActive: false,
        signal: new AbortController().signal,
      });
      return (listed?.kind === "completed" ? listed.lines : []).join("\n");
    };
    const first = await list();
    expect(first).toMatch(/Findings \(generation [0-9a-f]{12}\): 1 error, 1 warning, 0 info\./u);
    expect(first).toContain(
      "error metadata-invalid · broken (user-agents .agents/skills/broken/SKILL.md)",
    );
    expect(first).toContain("warning reference-missing · linked");
    expect(first).not.toContain("are stale");
    expect(first).not.toContain("BODY_");

    await write("broken", "---\nname: broken\ndescription: Fixed\n---\nBODY_broken\n");
    const second = await list();
    expect(second).toMatch(
      /Findings shown earlier for discovery generation [0-9a-f]{12} are stale; these are for [0-9a-f]{12}\./u,
    );
    expect(second).toMatch(/Findings \(generation [0-9a-f]{12}\): 0 error, 1 warning, 0 info\./u);
    expect(second).not.toContain("metadata-invalid");
    // Nothing was sent to a model.
    expect(shell.requests).toHaveLength(0);
  } finally {
    await shell.close();
  }
}, 30_000); // A real shell journey: trust, instruction scans and two catalog refreshes.
