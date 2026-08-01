/**
 * The keychain store, driven through a stubbed command runner.
 *
 * No test here spawns anything. The stub records every request, so the rules
 * the adapter is supposed to apply — structured argv, empty environment,
 * bounded output, a deadline — are asserted against what it actually asked for
 * rather than trusted. A real `security` invocation is a manual observation,
 * recorded in `CURRENT-STATE.md`.
 */

import { describe, expect, test } from "bun:test";

import {
  type CommandOutcome,
  type CredentialReference,
  createManualClock,
  createStubCommandRunner,
  DEFAULT_CREDENTIAL_TIMEOUT_MS,
  duration,
  type LocalDataPlatform,
  MAX_COMMAND_OUTPUT_BYTES,
} from "../domain/index.ts";
import {
  createKeychainCredentialStore,
  KEYCHAIN_EXIT_STATUSES,
  SECURITY_EXECUTABLE,
} from "./keychain-credentials.ts";

function exited(exitCode: number, stdout = ""): CommandOutcome {
  return { kind: "exited", exitCode, stdout };
}

function harness(
  outcome: CommandOutcome | ((argv: readonly string[]) => CommandOutcome),
  platform: LocalDataPlatform = "darwin",
) {
  const commands = createStubCommandRunner((request) =>
    typeof outcome === "function" ? outcome(request.argv) : outcome,
  );
  const store = createKeychainCredentialStore({
    commands,
    clock: createManualClock(),
    platform,
  });
  return { commands, store };
}

function reference(overrides: Partial<CredentialReference> = {}): CredentialReference {
  return {
    storeKind: "operating-system-keychain",
    locator: "falryn-example-provider",
    consumer: "example-provider",
    accountLabel: "work@example.com",
    ...overrides,
  };
}

describe("what the adapter asks the host to run", () => {
  test("passes a structured argument vector to an absolute executable", async () => {
    const { commands, store } = harness(exited(0, "sk-live-value\n"));
    await store.read(reference(), (secret) => secret.length);

    const [request] = commands.requests();
    expect(request?.executable).toBe(SECURITY_EXECUTABLE);
    expect(request?.argv).toEqual([
      "find-generic-password",
      "-s",
      "falryn-example-provider",
      "-a",
      "work@example.com",
      "-w",
    ]);
  });

  test("supplies an empty environment rather than inheriting this process's", async () => {
    const { commands, store } = harness(exited(0, "value\n"));
    await store.read(reference(), (secret) => secret);
    expect(commands.requests()[0]?.environment).toEqual({});
  });

  test("bounds the output and carries a deadline", async () => {
    const { commands, store } = harness(exited(0, "value\n"));
    await store.read(reference(), (secret) => secret);

    const [request] = commands.requests();
    expect(request?.maxOutputBytes).toBe(MAX_COMMAND_OUTPUT_BYTES);
    expect(request?.timeoutMs).toBe(DEFAULT_CREDENTIAL_TIMEOUT_MS);
  });

  test("a per-request deadline overrides the store's default", async () => {
    const { commands, store } = harness(exited(0, "value\n"));
    await store.read(reference(), (secret) => secret, { timeoutMs: duration(250) });
    expect(commands.requests()[0]?.timeoutMs).toBe(duration(250));
  });

  test("omits the account argument when the reference names no account", async () => {
    const { commands, store } = harness(exited(0, "value\n"));
    await store.read(reference({ accountLabel: null }), (secret) => secret);
    expect(commands.requests()[0]?.argv).toEqual([
      "find-generic-password",
      "-s",
      "falryn-example-provider",
      "-w",
    ]);
  });
});

describe("reading a secret", () => {
  test("hands it to the callback and returns only that callback's result", async () => {
    const { store } = harness(exited(0, "sk-live-value\n"));
    const resolution = await store.read(reference(), (secret) => secret.length);

    expect(resolution.kind).toBe("resolved");
    if (resolution.kind !== "resolved") {
      throw new Error("expected a resolved outcome");
    }
    expect(resolution.value).toBe("sk-live-value".length);
    expect(resolution.health.state).toBe("present");
    expect(JSON.stringify(resolution)).not.toContain("sk-live");
  });

  test("strips exactly the one newline `security -w` adds", async () => {
    const { store } = harness(exited(0, "value with trailing space \n"));
    const resolution = await store.read(reference(), (secret) => secret);
    // Trimming further would silently alter a secret ending in whitespace.
    expect(resolution.kind === "resolved" && resolution.value).toBe("value with trailing space ");
  });

  test("an entry holding nothing is empty rather than missing", async () => {
    const { store } = harness(exited(0, "\n"));
    const resolution = await store.read(reference(), (secret) => secret);
    expect(resolution.kind === "unresolved" && resolution.failure.status).toBe("empty");
  });

  test("output past the bound is refused rather than returned short", async () => {
    // A prefix of an over-long value is not a shorter secret; it is a different
    // one, and using it would authenticate as nobody.
    const { store } = harness({ kind: "output-exceeded", maxOutputBytes: 64 });
    const resolution = await store.read(reference(), (secret) => secret);
    expect(resolution.kind === "unresolved" && resolution.failure.status).toBe("malformed");
    expect(resolution.kind === "unresolved" && resolution.failure.code).toBe(
      "spawn-output-exceeded",
    );
  });
});

describe("exit statuses", () => {
  test("each declared status maps to its own outcome", async () => {
    for (const [code, expected] of Object.entries(KEYCHAIN_EXIT_STATUSES)) {
      const { store } = harness(exited(Number(code)));
      const resolution = await store.read(reference(), (secret) => secret);
      expect(resolution.kind === "unresolved" && resolution.failure.status).toBe(expected);
      expect(resolution.kind === "unresolved" && resolution.failure.code).toBe(
        `keychain-exit-${code}`,
      );
    }
  });

  test("an item that does not exist is missing, and proves absence", async () => {
    const { store } = harness(exited(44));
    const resolution = await store.read(reference(), (secret) => secret);
    expect(resolution.kind === "unresolved" && resolution.failure.status).toBe("missing");
    expect(resolution.kind === "unresolved" && resolution.failure.health.state).toBe("absent");
  });

  test("a locked keychain proves nothing about whether the credential exists", async () => {
    const { store } = harness(exited(36));
    const resolution = await store.read(reference(), (secret) => secret);
    expect(resolution.kind === "unresolved" && resolution.failure.status).toBe("locked");
    expect(resolution.kind === "unresolved" && resolution.failure.health.state).toBe("unreachable");
    expect(resolution.kind === "unresolved" && resolution.failure.retryable).toBe(true);
  });

  test("a status this build does not know is unavailable, never missing", async () => {
    const { store } = harness(exited(7));
    const resolution = await store.read(reference(), (secret) => secret);
    expect(resolution.kind === "unresolved" && resolution.failure.status).toBe("unavailable");
    expect(resolution.kind === "unresolved" && resolution.failure.code).toBe("keychain-exit-7");
  });
});

describe("failures that are not exits", () => {
  test("a deadline reached reports timed out", async () => {
    const { store } = harness({ kind: "timed-out", timeoutMs: DEFAULT_CREDENTIAL_TIMEOUT_MS });
    const resolution = await store.read(reference(), (secret) => secret);
    expect(resolution.kind === "unresolved" && resolution.failure.status).toBe("timed-out");
  });

  test("an abort reports cancelled", async () => {
    const { store } = harness({ kind: "cancelled" });
    const resolution = await store.read(reference(), (secret) => secret);
    expect(resolution.kind === "unresolved" && resolution.failure.status).toBe("cancelled");
  });

  test("an already-aborted read never spawns anything", async () => {
    const controller = new AbortController();
    controller.abort();
    const { commands, store } = harness(exited(0, "value\n"));
    const resolution = await store.read(reference(), (secret) => secret, {
      signal: controller.signal,
    });

    expect(commands.requests()).toEqual([]);
    expect(resolution.kind === "unresolved" && resolution.failure.status).toBe("cancelled");
  });

  test("a command that could not start is unavailable", async () => {
    const { store } = harness({ kind: "spawn-failed", code: "ENOENT" });
    const resolution = await store.read(reference(), (secret) => secret);
    expect(resolution.kind === "unresolved" && resolution.failure.status).toBe("unavailable");
  });
});

describe("locators the adapter refuses to hand a subprocess", () => {
  test("a leading dash would be read as an option", async () => {
    const { commands, store } = harness(exited(0, "value\n"));
    const resolution = await store.read(reference({ locator: "-w" }), (secret) => secret);
    expect(resolution.kind === "unresolved" && resolution.failure.status).toBe("malformed");
    expect(commands.requests()).toEqual([]);
  });

  test("a control character cannot have come from this build", async () => {
    const { store } = harness(exited(0, "value\n"));
    const locator = `a${String.fromCharCode(1)}b`;
    const resolution = await store.read(reference({ locator }), (secret) => secret);
    expect(resolution.kind === "unresolved" && resolution.failure.status).toBe("malformed");
  });

  test("shell metacharacters are ordinary text, because no shell sees them", async () => {
    const { commands, store } = harness(exited(0, "value\n"));
    const resolution = await store.read(
      reference({ locator: "falryn; rm -rf /" }),
      (secret) => secret.length,
    );
    expect(resolution.kind).toBe("resolved");
    expect(commands.requests()[0]?.argv).toContain("falryn; rm -rf /");
  });
});

describe("unqualified platforms", () => {
  for (const platform of ["linux", "win32"] as const) {
    test(`${platform} reports unsupported with a reason and spawns nothing`, async () => {
      const { commands, store } = harness(exited(0, "value\n"), platform);

      const availability = store.availability();
      expect(availability.kind).toBe("unsupported");
      if (availability.kind !== "unsupported") {
        throw new Error("expected an unsupported availability");
      }
      expect(availability.platform).toBe(platform);
      expect(availability.reason.length).toBeGreaterThan(0);

      const resolution = await store.read(reference(), (secret) => secret);
      expect(resolution.kind === "unresolved" && resolution.failure.status).toBe("unsupported");
      expect(commands.requests()).toEqual([]);
    });
  }

  test("removal on an unqualified platform is unsupported, not a success", async () => {
    const { store } = harness(exited(0), "linux");
    expect((await store.removeSecret(reference())).result).toBe("unsupported");
  });
});

describe("deleting a stored secret", () => {
  test("uses the delete subcommand and reports removal", async () => {
    const { commands, store } = harness(exited(0));
    expect(await store.removeSecret(reference())).toEqual({ result: "removed", code: null });
    expect(commands.requests()[0]?.argv).toEqual([
      "delete-generic-password",
      "-s",
      "falryn-example-provider",
      "-a",
      "work@example.com",
    ]);
  });

  test("an item that was already gone is not-present rather than failed", async () => {
    const { store } = harness(exited(44));
    expect(await store.removeSecret(reference())).toEqual({ result: "not-present", code: null });
  });

  test("a refusal is failed, and names the status it saw", async () => {
    const { store } = harness(exited(51));
    expect(await store.removeSecret(reference())).toEqual({
      result: "failed",
      code: "keychain-exit-51",
    });
  });
});
