import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configurationGeneration, managedServiceId } from "../domain/index.ts";
import { createHostManagedServicePort } from "../integrations/host-process-sessions.ts";
import { createLanguageServerSupervisor } from "./language-server.ts";

const POSIX = process.platform !== "win32";
const platformTest = POSIX ? test : test.skip;
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "language-server-fixtures.ts");
const BUN = process.execPath;

describe("language-server host integration", () => {
  platformTest("initializes and shuts down a real stdio fixture process", async () => {
    const supervisor = createLanguageServerSupervisor(createHostManagedServicePort());
    const serviceId = managedServiceId.from("lsp:fixture");
    const started = await supervisor.start({
      serviceId,
      key: {
        workspaceRoot: "/tmp/falryn-lsp-fixture",
        serverName: "fixture-lsp",
        configurationGeneration: configurationGeneration.from(0),
      },
      executable: BUN,
      argv: [FIXTURE],
      environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      initialize: {
        processId: process.pid,
        rootUri: "file:///tmp/falryn-lsp-fixture",
        workspaceFolders: [{ uri: "file:///tmp/falryn-lsp-fixture", name: "falryn-lsp-fixture" }],
        capabilities: {},
        clientInfo: { name: "falryn-test", version: "0.0.0" },
      },
      limits: {
        initializeTimeoutMs: 5_000,
        shutdownTimeoutMs: 5_000,
        maxRestarts: 0,
      },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    expect(started.value.state).toBe("ready");
    expect(started.value.serverInfo).toEqual({ name: "fixture-lsp", version: "0.0.1" });

    const stopped = await supervisor.shutdown(serviceId, started.value.generation);
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) {
      return;
    }
    expect(stopped.value.state).toBe("stopped");
  });
});
