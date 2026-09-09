import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { createStaticEnvironment } from "../../domain/foundation/index.ts";
import { decodeRuntimeEvent, encodeRuntimeEvent } from "../../domain/sessions/codec.ts";
import { localPath } from "../../domain/workspace/index.ts";
import { reduceTranscript } from "../../presentation/transcript/reducer.ts";
import { dispatch } from "../dispatch.ts";
import type { GlobalOptions } from "../options.ts";
import { createRecordingCliStreams } from "../output/streams.ts";
import {
  loadProductConfiguration,
  productConfigurationLoadRequest,
} from "./product-configuration.ts";
import { createServiceProvider } from "./services.ts";
import { inspectWorkspaceTrust, workspaceTrustEvent } from "./workspace-trust.ts";

const roots: string[] = [];
test("maximum inventories fit the event limit and replay only as decision facts", () => {
  const digest = canonicalDigest("inventory");
  const event = workspaceTrustEvent(
    {
      version: 1,
      status: "accepted",
      priorGeneration: null,
      reason: "recorded-decision-matched",
      added: 1024,
      removed: 0,
      changed: 0,
      inventory: {
        version: 1,
        identity: digest,
        generation: digest,
        policy: 1,
        configuration: digest,
        loaders: Array.from({ length: 1024 }, () => ({
          source: digest,
          digest,
          sourceVersion: digest,
          label: "x".repeat(256),
          bytes: 1,
          family: "skills",
          activation: "unavailable",
        })),
      },
    },
    100,
  );
  const encoded = encodeRuntimeEvent(event);
  expect(encoded.ok).toBe(true);
  if (!encoded.ok) throw new Error("event encoding failed");
  expect(decodeRuntimeEvent(encoded.value)).toEqual({ ok: true, value: event });
  expect(JSON.stringify(event)).not.toContain("x".repeat(256));
  expect(JSON.stringify(event)).toContain('"count":1024');
  const replay = reduceTranscript([event]);
  expect(replay.blocks).toHaveLength(1);
  expect(replay.blocks[0]?.kind).toBe("notice");
});
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "falryn-workspace-review-"));
  roots.push(home);
  const work = join(home, "workspace");
  await mkdir(join(work, ".falryn"), { recursive: true });
  await writeFile(join(work, "AGENTS.md"), "token=never-display-this-value");
  await writeFile(
    join(work, ".falryn", "falryn.jsonc"),
    JSON.stringify({ schemaVersion: 1, diagnostics: { level: "warn" } }),
  );
  const environment = createStaticEnvironment({
    FALRYN_STATE_DIR: join(home, "state"),
    FALRYN_CONFIG_DIR: join(home, "config"),
  });
  const globals: GlobalOptions = {
    format: "json",
    color: "never",
    nonInteractive: true,
    profile: null,
    quiet: false,
    timeoutMs: null,
    verbose: false,
    workspace: work,
    addDirs: [],
    help: false,
    version: false,
  };
  const provider = (options = globals) =>
    createServiceProvider(options, {
      home: localPath(home),
      currentDirectory: localPath(work),
      environment,
    });
  return { home, work, globals, provider };
}
test("real headless entry returns trust-required in all projections; exact approval persists and source changes invalidate", async () => {
  const { work, globals, provider } = await fixture();
  for (const format of ["human", "quiet", "json", "jsonl"] as const) {
    const streams = createRecordingCliStreams();
    const code = await dispatch({
      argv: ["run", "--workspace", work, "--format", format, "--non-interactive", "Inspect"],
      streams,
      services: provider,
    });
    expect(code).not.toBe(0);
    const text = [...streams.resultWrites(), ...streams.diagnosticWrites()].join("");
    expect(text).toContain("workspace.trust-required");
    expect(text).not.toContain("never-display-this-value");
    expect(text).not.toContain("\u001b");
    if (format === "jsonl") expect(text).toContain("workspace.trust.reviewed");
  }
  const graph = provider()();
  expect(
    (await loadProductConfiguration(graph, productConfigurationLoadRequest(globals))).values[
      "diagnostics.level"
    ],
  ).not.toBe("warn");
  expect((await graph.workspaceTrust.resolve(async () => "proceed")).status).toBe("accepted");
  const restarted = provider()();
  expect((await restarted.workspaceTrust.resolve()).status).toBe("accepted");
  expect(
    (await loadProductConfiguration(restarted, productConfigurationLoadRequest(globals))).values[
      "diagnostics.level"
    ],
  ).toBe("warn");
  expect((await inspectWorkspaceTrust(restarted, globals)).status).toBe("accepted");
  await writeFile(join(work, "AGENTS.md"), "Changed generation");
  const changed = await loadProductConfiguration(
    restarted,
    productConfigurationLoadRequest(globals),
  );
  expect(changed.trust.status).toBe("stale");
  expect(changed.values["diagnostics.level"]).not.toBe("warn");
  expect((await provider()().workspaceTrust.resolve()).status).toBe("stale");
});
test("canonical root aliases reuse approval; nested roots, escapes and malformed declarations cannot inherit it", async () => {
  const { home, work, globals, provider } = await fixture();
  expect((await provider()().workspaceTrust.resolve(async () => "proceed")).status).toBe(
    "accepted",
  );
  await mkdir(join(work, "nested"));
  await writeFile(join(work, "nested", "AGENTS.md"), "nested instructions");
  expect(
    (await provider({ ...globals, workspace: join(work, "nested") })().workspaceTrust.resolve())
      .status,
  ).toBe("review-required");
  expect(
    (await provider({ ...globals, addDirs: [join(work, "nested")] })().workspaceTrust.resolve())
      .status,
  ).toBe("failed");
  if (process.platform !== "win32") {
    await symlink(work, join(home, "alias"));
    expect(
      (await provider({ ...globals, workspace: join(home, "alias") })().workspaceTrust.resolve())
        .status,
    ).toBe("accepted");
    await symlink(join(home, "outside"), join(work, ".falryn", "hooks"));
    expect((await provider()().workspaceTrust.resolve()).reason).toBe("inventory-path-escape");
    await rm(join(work, ".falryn", "hooks"));
  }
  await writeFile(join(work, ".falryn", "mcp.json"), "{ broken");
  expect((await provider()().workspaceTrust.resolve()).reason).toBe("inventory-malformed");
});

test("changes to user configuration invalidate prior project approval", async () => {
  const { home, provider, globals } = await fixture();
  const graph = provider()();
  expect((await graph.workspaceTrust.resolve(async () => "proceed")).status).toBe("accepted");
  await mkdir(join(home, "config"), { recursive: true });
  await writeFile(
    join(home, "config", "falryn.jsonc"),
    JSON.stringify({ schemaVersion: 1, diagnostics: { level: "debug" } }),
  );
  const loaded = await loadProductConfiguration(graph, productConfigurationLoadRequest(globals));
  expect(loaded.trust.status).toBe("stale");
  expect(loaded.values["diagnostics.level"]).toBe("debug");
});
