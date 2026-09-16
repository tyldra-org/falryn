/** Compiled test entry only; production main never imports this scripted provider. */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { instructionProduct } from "./instruction-product.fixtures.ts";

const home = process.argv[2];
if (!home) throw new Error("fixture-home-required");
const product = await instructionProduct(home);
await writeFile(join(home, "config", "AGENTS.md"), "COMPILED_INSTRUCTION_RULE");
await product.setting("instructions.sources", {
  version: 1,
  entries: [{ root: "configuration", path: "AGENTS.md", scope: "", enabled: true, references: [] }],
});
const run = await product.run();
if (run.result.outcome.kind !== "completed") console.error(JSON.stringify(run.result));
const admitted = (JSON.stringify(run.requests[0]?.messages) ?? "").includes(
  "COMPILED_INSTRUCTION_RULE",
);
console.log(
  JSON.stringify({
    outcome: run.result.outcome.kind,
    admitted,
    sources: run.result.payload?.instructions?.sources.length,
  }),
);
process.exitCode = run.result.outcome.kind === "completed" && admitted ? 0 : 1;
