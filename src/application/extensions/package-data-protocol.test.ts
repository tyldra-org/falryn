import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { removeTemporaryRoots } from "../../data/fixtures.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { packageDataFixture } from "./package-data.fixtures.ts";
import { createPackageDataProtocol } from "./package-data-protocol.ts";
import { createEphemeralPackageState } from "./package-ephemeral-state.ts";

afterEach(removeTemporaryRoots);
test("supervised contract fences foreign and revoked calls; ephemeral state cannot survive a host", async () => {
  const fixture = await packageDataFixture();
  try {
    const current = fixture.packages.current("fixture");
    if (!current.ok || !current.value.current) throw new Error("missing package");
    const binding = {
      version: 1 as const,
      packageId: "fixture",
      packageDigest: current.value.current.identityDigest,
      packageVersion: "1.0.0",
      contribution: null,
      packageRevision: 1,
      configurationGeneration: 1,
      catalogGeneration: "catalog-one",
      workspaceGeneration: "roots-one",
      sessionGeneration: null,
      protocolGeneration: "package-data-v1",
      authority: canonicalDigest("admitted"),
    };
    let admitted = true;
    const authority = {
      binding,
      hostControl: false,
      current: () => admitted,
      allows: (_scope: string, owner: string) => owner === "test-user" || owner === "process-one",
    };
    const ephemeral = createEphemeralPackageState(fixture.data);
    const protocol = createPackageDataProtocol({
      store: fixture.data,
      ephemeralStore: ephemeral.store,
      authority,
      now: () => 1000,
    });
    const configuration = { version: 1, operation: "configuration", binding };
    expect(protocol.receive(configuration)).toMatchObject({
      status: "configuration",
      snapshot: { values: { "display.label": "default" } },
    });
    expect(
      protocol.receive({ ...configuration, binding: { ...binding, contribution: "foreign" } }),
    ).toMatchObject({ status: "failed", code: "foreign-package-binding" });
    const request = {
      version: 1,
      operation: "state",
      binding,
      operationId: randomUUID(),
      expectedRevision: 1,
      state: {
        version: 1,
        operation: "put",
        identity: { ...fixture.identity, scope: "process", owner: "process-one" },
        expectedRevision: 0,
        value: { color: "blue" },
      },
    };
    expect(protocol.receive(request)).toMatchObject({
      status: "completed",
      receipt: { afterRevision: 2 },
    });
    expect(fixture.data.read("fixture")).toMatchObject({
      ok: true,
      value: { revision: 1, records: [] },
    });
    const get = {
      ...request,
      operationId: randomUUID(),
      expectedRevision: 2,
      state: { version: 1, operation: "get", identity: request.state.identity },
    };
    expect(protocol.receive(get)).toMatchObject({
      status: "read",
      value: { value: { color: "blue" } },
    });
    ephemeral.close();
    expect(protocol.receive(get)).toMatchObject({
      status: "failed",
      code: "ephemeral-owner-closed",
    });
    const restarted = createPackageDataProtocol({
      store: fixture.data,
      ephemeralStore: createEphemeralPackageState(fixture.data).store,
      authority,
      now: () => 2000,
    });
    expect(restarted.receive(get)).toMatchObject({
      status: "read",
      value: { revision: 0, value: null },
    });
    const durable = {
      ...request,
      operationId: randomUUID(),
      state: { ...request.state, identity: fixture.identity },
    };
    expect(protocol.receive(durable)).toMatchObject({ status: "completed" });
    expect(protocol.receive(configuration)).toMatchObject({ status: "configuration" });
    admitted = false;
    expect(protocol.receive(configuration)).toMatchObject({
      status: "failed",
      code: "revoked-package-data",
    });
  } finally {
    await fixture.store.close();
  }
});
