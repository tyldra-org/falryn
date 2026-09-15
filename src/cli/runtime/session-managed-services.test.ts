import { expect, test } from "bun:test";
import { duration, managedServiceId } from "../../domain/foundation/index.ts";
import type { ManagedServiceRequest } from "../../domain/process/index.ts";
import { createHostManagedServicePort } from "../../integrations/process/host-process-sessions.ts";
import { sessionManagedServices } from "./session-managed-services.ts";

const posixTest = process.platform === "win32" ? test.skip : test;
posixTest(
  "repeated session settlement detaches listeners and stops only its real managed processes",
  async () => {
    const shared = createHostManagedServicePort();
    const request = (name: string): ManagedServiceRequest => ({
      serviceId: managedServiceId.from(name),
      protocol: "activation-test",
      executable: "/bin/sh",
      argv: ["-c", "printf 'ready\\n'; while IFS= read -r line; do printf '%s\\n' \"$line\"; done"],
      environment: { PATH: "/usr/bin:/bin" },
      readiness: {
        kind: "output-marker",
        marker: "ready",
        stream: "stdout",
        timeoutMs: duration(2000),
      },
      idle: { kind: "disabled" },
      restart: { maxRestarts: 0, windowMs: duration(2000) },
      shutdownTimeoutMs: duration(1000),
      replayBytes: 128,
    });
    const sibling = sessionManagedServices(shared);
    try {
      const other = await sibling.port.start(request("other-session"));
      expect(other.ok).toBe(true);
      for (let index = 0; index < 3; index++) {
        const selected = sessionManagedServices(shared);
        let callbacks = 0;
        try {
          const opened = await selected.port.start(request(`selected-${index}`));
          if (!opened.ok) throw new Error(opened.error.code);
          expect(
            selected.port.attach(opened.value.serviceId, () => {
              callbacks++;
            }).ok,
          ).toBe(true);
          await selected.close();
          expect(shared.snapshot(opened.value.serviceId)?.state).toBe("stopped");
          expect(shared.snapshot(managedServiceId.from("other-session"))?.state).toBe("ready");
          const settled = callbacks;
          await selected.close();
          expect(callbacks).toBe(settled);
          expect((await selected.port.start(request(`late-${index}`))).ok).toBe(false);
        } finally {
          await selected.close();
        }
      }
    } finally {
      await sibling.close();
    }
  },
);
