import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStaticEnvironment,
  duration,
  managedServiceId,
} from "../../domain/foundation/index.ts";
import { localPath } from "../../domain/workspace/index.ts";
import { createHostCommandRunner } from "../../integrations/process/host-commands.ts";
import {
  createHostManagedServicePort,
  createHostPtySessionPort,
} from "../../integrations/process/host-process-sessions.ts";
import type { GlobalOptions } from "../options.ts";
import { createServiceProvider } from "./services.ts";
import { standaloneEnvironment } from "./standalone-environment.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const posix = process.platform === "win32" ? test.skip : test;
const zsh = process.platform !== "win32" && Bun.which("zsh") ? test : test.skip;
const interpreter = process.platform === "darwin" ? "/bin/zsh" : "/usr/bin/zsh";
async function fixture(environment: unknown, script = "") {
  const root = await mkdtemp(join(tmpdir(), "falryn-environment-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const config = join(root, "config");
  const workspace = join(root, "workspace");
  await mkdir(join(config, "profiles"), { recursive: true });
  await mkdir(workspace);
  await writeFile(
    join(config, "falryn.jsonc"),
    JSON.stringify({
      schemaVersion: 2,
      minimumReaderSchemaVersion: 2,
      defaults: { execution: { environment } },
    }),
  );
  await writeFile(join(config, "env.zsh"), script);
  const globals: GlobalOptions = {
    color: "never",
    format: "json",
    nonInteractive: true,
    profile: null,
    quiet: false,
    timeoutMs: null,
    verbose: false,
    workspace,
    addDirs: [],
    help: false,
    version: false,
  };
  async function open(profile: string | null = null) {
    const selected = { ...globals, profile };
    const graph = createServiceProvider(selected, {
      home: localPath(root),
      currentDirectory: localPath(workspace),
      environment: createStaticEnvironment({
        FALRYN_CONFIG_DIR: config,
        FALRYN_STATE_DIR: join(root, "state"),
        EMPTY: "",
        BASE: "inherited",
      }),
    })();
    const runtime = await standaloneEnvironment(graph, selected);
    cleanups.push(runtime.close);
    return { ...runtime, graph };
  }
  return { root, config, workspace, open };
}
const read = (context: Awaited<ReturnType<typeof standaloneEnvironment>>["context"]) =>
  context.commands(createHostCommandRunner()).run({
    executable: "/bin/sh",
    argv: ["-c", `printf "%s|%s|%s|%s" "$VALUE" "$SOURCE" "$BASE" "\${EMPTY+x}"`],
    environment: {},
    timeoutMs: duration(1000),
    maxOutputBytes: 1024,
  });

posix("structured edits preserve empty inheritance and script presence remains inert", async () => {
  const f = await fixture(
    { set: { VALUE: "structured" }, inheritedNames: ["EMPTY", "BASE"] },
    "exit 1",
  );
  const runtime = await f.open();
  expect((await runtime.control.execute("inspect")).inspection.state).toBe("unavailable");
  expect((await runtime.control.execute("reload")).inspection.state).toBe("active");
  expect(await read(runtime.context)).toMatchObject({
    kind: "exited",
    stdout: "structured||inherited|x",
  });
});

zsh(
  "two profiled runtimes isolate reload, pin async work, and retain managed and PTY children",
  async () => {
    const f = await fixture(
      {
        inheritedNames: ["BASE", "EMPTY"],
        preparation: { interpreter, exports: ["SOURCE"], required: true },
      },
      "export SOURCE=old",
    );
    for (const name of ["a", "b"])
      await writeFile(
        join(f.config, "profiles", `${name}.jsonc`),
        JSON.stringify({
          schemaVersion: 2,
          minimumReaderSchemaVersion: 2,
          overrides: { execution: { environment: { set: { VALUE: name } } } },
        }),
      );
    const a = await f.open("a");
    const b = await f.open("b");
    expect((await a.control.execute("reload")).inspection.state).toBe("active");
    expect((await b.control.execute("reload")).inspection.state).toBe("active");
    const old = a.context.scope();
    const service = a.context.services(createHostManagedServicePort());
    const started = await service.start({
      serviceId: managedServiceId.from("environment-fixture"),
      protocol: "fixture",
      executable: "/bin/sh",
      argv: [
        "-c",
        'printf "ready:%s\\n" "$SOURCE"; while IFS= read line; do printf "reply:%s\\n" "$SOURCE"; done',
      ],
      environment: {},
      readiness: {
        kind: "output-marker",
        marker: "ready:old",
        stream: "stdout",
        timeoutMs: duration(1000),
      },
      idle: { kind: "disabled" },
      restart: { maxRestarts: 0, windowMs: duration(1000) },
      shutdownTimeoutMs: duration(1000),
      replayBytes: 2048,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("service-fixture-unavailable");
    cleanups.push(() =>
      service.stop(started.value.serviceId, started.value.generation, "shutdown"),
    );
    const pty = a.context.pty(createHostPtySessionPort());
    const opened = await pty.open({
      executable: "/bin/sh",
      argv: [
        "-c",
        'printf "ready:%s\\n" "$SOURCE"; IFS= read line; printf "reply:%s\\n" "$SOURCE"',
      ],
      environment: {},
      dimensions: { columns: 80, rows: 24 },
      backlogBytes: 2048,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("pty-fixture-unavailable");
    cleanups.push(() => pty.terminate(opened.value.sessionId));
    await writeFile(join(f.config, "env.zsh"), "export SOURCE=new");
    const reloaded = await a.control.execute("reload");
    expect(reloaded.inspection.state).toBe("active");
    expect(reloaded.restartRequired).toHaveLength(2);
    expect(await read(a.context)).toMatchObject({ kind: "exited", stdout: "a|new|inherited|x" });
    expect(await old(() => read(a.context))).toMatchObject({
      kind: "exited",
      stdout: "a|old|inherited|x",
    });
    expect(await read(b.context)).toMatchObject({ kind: "exited", stdout: "b|old|inherited|x" });
    await service.send(
      started.value.serviceId,
      started.value.generation,
      new TextEncoder().encode("go\n"),
    );
    pty.write(opened.value.sessionId, new TextEncoder().encode("go\n"));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(new TextDecoder().decode(pty.snapshot(opened.value.sessionId)?.replay.bytes)).toContain(
      "reply:old",
    );
    const attached = service.attach(started.value.serviceId, () => {});
    expect(attached.ok).toBe(true);
    if (attached.ok) {
      expect(new TextDecoder().decode(attached.value.replay.stdout)).toContain("reply:old");
      attached.value.detach();
    }
    await writeFile(join(f.config, "env.zsh"), "exit 9");
    expect((await a.control.execute("reload")).inspection.state).toBe("blocked");
    expect(await read(a.context)).toMatchObject({ kind: "spawn-failed" });
    expect(await old(() => read(a.context))).toMatchObject({
      kind: "exited",
      stdout: "a|old|inherited|x",
    });
  },
);

zsh(
  "project preparation requires current exact trust and never changes the configuration bridge",
  async () => {
    const f = await fixture({ set: { VALUE: "user" } });
    await mkdir(join(f.workspace, ".falryn"));
    await writeFile(
      join(f.workspace, ".falryn", "falryn.jsonc"),
      JSON.stringify({
        schemaVersion: 2,
        minimumReaderSchemaVersion: 2,
        defaults: {
          execution: {
            environment: {
              preparation: { interpreter, exports: ["SOURCE", "FALRYN_LOG_LEVEL"], required: true },
            },
          },
        },
      }),
    );
    const source = join(f.workspace, ".falryn", "env.zsh");
    await writeFile(source, "export SOURCE=project FALRYN_LOG_LEVEL=debug");
    const runtime = await f.open();
    expect((await runtime.control.execute("inspect")).inspection.generation).toBeNull();
    expect((await runtime.graph.workspaceTrust.resolve(async () => "proceed")).status).toBe(
      "accepted",
    );
    expect((await runtime.control.execute("reload")).inspection.state).toBe("active");
    expect(await read(runtime.context)).toMatchObject({ kind: "exited", stdout: "user|project||" });
    expect(runtime.graph.loader.current()?.values["diagnostics.level"]).toBe("info");
    await writeFile(source, "export SOURCE=replaced");
    expect(await read(runtime.context)).toMatchObject({ kind: "spawn-failed" });
    expect((await runtime.control.execute("reload")).inspection.state).toBe("blocked");
    expect((await runtime.graph.workspaceTrust.resolve(async () => "proceed")).status).toBe(
      "accepted",
    );
    expect((await runtime.control.execute("reload")).inspection.state).toBe("active");
  },
);

zsh(
  "optional failure omits the whole delta, and cancellation blocks required preparation",
  async () => {
    const optional = await fixture(
      {
        set: { VALUE: "structured" },
        preparation: { interpreter, exports: ["SOURCE"], required: false },
      },
      "export SOURCE=partial; return 1",
    );
    const first = await optional.open();
    expect((await first.control.execute("reload")).inspection.state).toBe("degraded");
    expect(await read(first.context)).toMatchObject({ kind: "exited", stdout: "structured|||" });
    const required = await fixture(
      { preparation: { interpreter, exports: ["SOURCE"], required: true } },
      "export SOURCE=partial; /bin/sleep 10",
    );
    const second = await required.open();
    const result = await second.control.execute("reload", AbortSignal.timeout(100));
    expect(result.transition?.kind).toBe("receipt");
    expect(await read(second.context)).toMatchObject({ kind: "spawn-failed" });
    expect(JSON.stringify(result)).not.toContain("partial");
  },
);

zsh(
  "only runtime mappings cross the user bridge; roots stay bootstrap-bound and receipts exclude values",
  async () => {
    const f = await fixture(
      {
        preparation: {
          interpreter,
          exports: ["FALRYN_LOG_LEVEL", "FALRYN_STATE_DIR", "SECRET"],
          required: true,
        },
      },
      "export FALRYN_LOG_LEVEL=debug FALRYN_STATE_DIR=/invalid-root SECRET=private-fixture-value",
    );
    const runtime = await f.open();
    const result = await runtime.control.execute("reload");
    expect(result.inspection.state).toBe("active");
    expect(runtime.graph.loader.current()?.values["diagnostics.level"]).toBe("debug");
    expect(result.inspection.ineligibleMappings).toContain("FALRYN_STATE_DIR");
    expect(JSON.stringify(result)).not.toContain("private-fixture-value");
    expect(JSON.stringify(result)).not.toContain("/invalid-root");
  },
);
