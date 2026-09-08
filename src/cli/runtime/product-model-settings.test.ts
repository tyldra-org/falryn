import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStaticEnvironment } from "../../domain/foundation/index.ts";
import { localPath } from "../../domain/workspace/index.ts";
import { roleRouteBaseSchema } from "../../providers/configuration/policy-schema.ts";
import { parseInvocation } from "../command-tree.ts";
import { runModel } from "../commands/model.ts";
import type { GlobalOptions } from "../options.ts";
import { composeProductModelSettings } from "./product-model-settings.ts";
import { createServiceProvider } from "./services.ts";

const GLOBALS: GlobalOptions = {
  color: "auto",
  format: "human",
  nonInteractive: true,
  profile: null,
  quiet: false,
  timeoutMs: null,
  verbose: false,
  workspace: null,
  addDirs: [],
  help: false,
  version: false,
};
test("CLI and restarted product settings share atomic configuration, migration recovery and stale revision detection", async () => {
  const home = await mkdtemp(join(tmpdir(), "falryn-model-settings-"));
  try {
    const services = createServiceProvider(GLOBALS, {
      home: localPath(home),
      platform: "darwin",
      currentDirectory: localPath(home),
      environment: createStaticEnvironment({ FALRYN_STATE_DIR: home }),
    });
    const service = composeProductModelSettings(services(), GLOBALS);
    const inspection = await service.execute({ kind: "inspect" });
    if (inspection.kind !== "inspection") throw new Error(JSON.stringify(inspection));
    const main = inspection.rows[0]?.selection;
    if (main?.kind !== "route") throw new Error("Expected the configured main model");
    const input = join(home, "edit.json");
    await writeFile(
      input,
      JSON.stringify({
        kind: "edit",
        edit: { kind: "configure", target: { kind: "role", role: "fast" }, route: main.route },
        expectedRevision: inspection.fileRevision,
      }),
    );
    const invocation = await parseInvocation(["model", "configure", "--input", input]);
    if (invocation.kind !== "run" || invocation.modelArgs === undefined)
      throw new Error("Expected model command");
    const result = await runModel(services, invocation.modelArgs, GLOBALS);
    expect(result.payload?.kind).toBe("written");
    const restarted = composeProductModelSettings(services(), GLOBALS);
    const after = await restarted.execute({ kind: "inspect" });
    if (after.kind !== "inspection") throw new Error("Expected inspection after restart");
    expect(after.preferences.roles.fast?.default).toEqual(main.route);
    expect(after.preferences.roles.fast?.use).toBeUndefined();
    expect((await runModel(services, invocation.modelArgs, GLOBALS)).payload).toEqual({
      kind: "failed",
      code: "stale-settings",
    });
    const original = {
      roles: {
        default: main.route,
        compact: { ...roleRouteBaseSchema.parse(main.route), use: "off" },
      },
    };
    const preview = await restarted.execute({ kind: "preview-migration", original });
    if (preview.kind !== "preview") throw new Error("Expected migration preview");
    const applied = await restarted.execute({
      kind: "apply-migration",
      original,
      candidate: preview.candidate,
      decisions: {},
      expectedRevision: after.fileRevision,
    });
    if (applied.kind !== "written" || applied.backup === null)
      throw new Error(JSON.stringify(applied));
    const recovery = JSON.parse(await readFile(applied.backup, "utf8"));
    expect(recovery.original.original).toEqual(original);
    const latest = await restarted.execute({ kind: "inspect" });
    expect(latest.kind === "inspection" && latest.preferences.roles.fast?.use?.memory).toBe("off");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
