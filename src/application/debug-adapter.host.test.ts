import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configurationGeneration, managedServiceId } from "../domain/index.ts";
import { createHostManagedServicePort } from "../integrations/host-process-sessions.ts";
import { createDebugAdapterSupervisor } from "./debug-adapter.ts";

const POSIX = process.platform !== "win32";
const platformTest = POSIX ? test : test.skip;
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "debug-adapter-fixtures.ts");
const BUN = process.execPath;

describe("debug-adapter host integration", () => {
  platformTest("initializes and disconnects a real stdio fixture process", async () => {
    const supervisor = createDebugAdapterSupervisor(createHostManagedServicePort());
    const serviceId = managedServiceId.from("dap:fixture");
    const started = await supervisor.start({
      serviceId,
      key: {
        workspaceRoot: "/tmp/falryn-dap-fixture",
        adapterName: "fixture-dap",
        configurationGeneration: configurationGeneration.from(0),
      },
      executable: BUN,
      argv: [FIXTURE],
      environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      initialize: {
        clientID: "falryn-test",
        clientName: "Falryn Test",
        adapterID: "fixture",
        pathFormat: "path",
        linesStartAt1: true,
        columnsStartAt1: true,
      },
      limits: {
        initializeTimeoutMs: 5_000,
        disconnectTimeoutMs: 5_000,
        maxRestarts: 0,
      },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    expect(started.value.state).toBe("ready");
    expect(started.value.capabilities).toMatchObject({
      supportsConfigurationDoneRequest: true,
      supportsTerminateRequest: true,
    });

    const stopped = await supervisor.disconnect(serviceId, started.value.generation);
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) {
      return;
    }
    expect(stopped.value.state).toBe("stopped");
  });
});
