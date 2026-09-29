import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamId } from "../../domain/foundation/index.ts";
import { instructionProduct } from "../runtime/instruction-product.fixtures.ts";
import { openProductArtifactSession } from "../runtime/product-artifact-session.ts";
import { runExtensionSkills } from "./extension-skills.ts";
import { skillUsageCliJourney } from "./extension-skills-fixtures.ts";

const COMMAND = [process.execPath, "run", new URL("../../main.ts", import.meta.url).pathname];
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function home() {
  const created = await mkdtemp(join(tmpdir(), "falryn-skill-usage-"));
  homes.push(created);
  return created;
}

// Three real product turns, a restart and several CLI processes: seconds on a hosted runner.
test("real turns yield source-bound usage; inspection after restart records nothing new", async () => {
  const root = await home();
  const { report, events, cli } = await skillUsageCliJourney(COMMAND, root);
  if (report.status !== "reported") throw new Error(report.status);
  const session = report.coverage.sessions[0]?.sessionId ?? "";
  // A new process inspects twice, one session at a time and paged; the stream is unchanged.
  const restarted = await instructionProduct(root);
  const paged = await runExtensionSkills(restarted.services, { session, limit: 2 });
  if (paged.payload?.status !== "reported") throw new Error("paged");
  expect(paged.payload.next).not.toBeNull();
  const again = await runExtensionSkills(restarted.services, { session });
  expect(again.payload).toEqual({ ...report, query: { session } });
  const store = await openProductArtifactSession(restarted.services());
  if (!store) throw new Error("store");
  try {
    const after = await store.eventStore.readFrom(
      { streamId: streamId.from(`live-turn:${session}`), afterSequence: null },
      1000,
    );
    expect(after.ok && after.value.length).toBe(events.length);
  } finally {
    await store.close();
  }
  // An unknown session is refused through the process boundary without revealing anything.
  const request = join(root, "unknown-session.json");
  await writeFile(request, JSON.stringify({ session: "session-unknown" }));
  const unknown = cli(["--format", "json", "--input", request]);
  expect(unknown.exitCode).not.toBe(0);
  expect(JSON.parse(unknown.stdout).payload).toEqual({
    status: "failed",
    code: "session-unavailable",
  });
  // A request outside the schema is invalid before anything is opened.
  await writeFile(request, JSON.stringify({ session: "x", limit: 0 }));
  expect(cli(["--input", request]).exitCode).not.toBe(0);
}, 30_000);

test("a workspace with no admissions reports usage as unavailable, not zero", async () => {
  const product = await instructionProduct(await home());
  const result = await runExtensionSkills(product.services, {});
  expect(result.payload).toMatchObject({ status: "reported", admissions: 0, rows: [] });
  expect(result.outcome.kind).toBe("completed");
  const refused = await runExtensionSkills(product.services, { session: "session-unknown" });
  expect(refused.payload).toEqual({ status: "failed", code: "session-unavailable" });
});
