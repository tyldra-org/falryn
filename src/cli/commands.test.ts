import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REDACTED } from "../application/index.ts";
import {
  CONFIGURATION_FILE_NAME,
  CONFIGURATION_SCHEMA_VERSION,
  SCHEMA_VERSION_FIELD,
} from "../config/index.ts";
import { createStaticEnvironment, localPath } from "../domain/index.ts";
import { runConfigPath, runConfigShow, runConfigValidate, runDoctor } from "./commands.ts";
import { DIAGNOSTIC_LEVEL_KEY, type GlobalOptions } from "./options.ts";
import { createServiceProvider, type ServiceProvider } from "./services.ts";

/** Token-shaped text the runtime redactor recognizes. Never a real credential. */
const SECRET = "sk-live-ABCDEFGH12345678";

const DEFAULTS: GlobalOptions = {
  format: "human",
  color: "auto",
  quiet: false,
  verbose: false,
  nonInteractive: false,
  workspace: null,
  profile: null,
  timeoutMs: null,
  help: false,
  version: false,
};

const roots: string[] = [];

/**
 * A provider over a temporary home.
 *
 * The real host adapters, so what is exercised is the composition rather than
 * a double — but never the developer's own roots.
 */
async function isolated(options: Partial<GlobalOptions> = {}, currentDirectory?: string) {
  const home = await mkdtemp(join(tmpdir(), "falryn-command-"));
  roots.push(home);
  const globals = { ...DEFAULTS, ...options };
  return {
    home,
    globals,
    services: createServiceProvider(globals, {
      home: localPath(home),
      platform: "darwin",
      environment: createStaticEnvironment({ FALRYN_STATE_DIR: home }),
      // Named rather than inherited so a relative `--workspace` resolves
      // against a known directory instead of wherever the suite was started.
      ...(currentDirectory === undefined ? {} : { currentDirectory: localPath(currentDirectory) }),
    }),
  };
}

/** Writes the user-scope configuration file this provider will read. */
async function writeUserConfiguration(
  services: ServiceProvider,
  document: Record<string, unknown>,
): Promise<void> {
  const root = services().configurationRoot;
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, CONFIGURATION_FILE_NAME),
    JSON.stringify({ [SCHEMA_VERSION_FIELD]: CONFIGURATION_SCHEMA_VERSION, ...document }),
  );
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

describe("config show", () => {
  test("reports the effective value of every declared key with its provenance", async () => {
    const { services, globals } = await isolated();
    const result = await runConfigShow(services, {}, globals);

    expect(result.outcome).toEqual({ kind: "completed" });
    expect(result.effect).toEqual({ intent: "none", observed: "none" });
    expect(result.payload?.usable).toBe(true);

    const values = result.payload?.inspection.values ?? [];
    expect(values.length).toBeGreaterThan(0);
    // Every value knows where it came from. That is the whole reason to ask.
    for (const value of values) {
      expect(typeof value.path).toBe("string");
      expect(value.source).not.toBeUndefined();
    }
  });

  test("applies a CLI override through the existing layer, not a rule of its own", async () => {
    const { services, globals } = await isolated();
    const result = await runConfigShow(services, { [DIAGNOSTIC_LEVEL_KEY]: "debug" }, globals);

    const level = result.payload?.inspection.values.find(
      (value) => value.path === DIAGNOSTIC_LEVEL_KEY,
    );
    expect(level?.value).toBe("debug");
    // `cli` is the highest layer in the precedence #8 already implements, and
    // the scope the override lands in.
    expect(level?.scope).toBe("cli");
  });

  test("reports an unknown override key rather than ignoring it", async () => {
    const { services, globals } = await isolated();
    const result = await runConfigShow(services, { "not.a.real.key": "1" }, globals);

    // A mistyped flag must not be silently dropped, exactly as a mistyped key
    // in a file is not.
    expect(result.outcome.kind).toBe("failed");
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("puts no secret in its payload", async () => {
    const { services, globals } = await isolated();
    // A real value someone typed a token into, not an empty configuration:
    // asserting the absence of a secret that was never present would pass with
    // redaction removed, which is no control at all. `data.roots.cache` is a
    // public string key, so its text reaches the redactor rather than being
    // withheld wholesale — the case where a leak would actually happen.
    await writeUserConfiguration(services, {
      data: { roots: { cache: `/tmp/falryn-cache-${SECRET}` } },
    });

    const result = await runConfigShow(services, {}, globals);
    expect(result.outcome).toEqual({ kind: "completed" });

    const cache = result.payload?.inspection.values.find(
      (value) => value.path === "data.roots.cache",
    );
    // The value is still reported, and still recognizable — this is redaction
    // rather than the key having failed to load.
    expect(String(cache?.value)).toContain("/tmp/falryn-cache-");
    expect(String(cache?.value)).toContain(REDACTED);

    const serialized = JSON.stringify(result.payload);
    expect(serialized).not.toContain(SECRET);
  });
});

describe("workspace resolution", () => {
  test("resolves a relative --workspace against the current directory", async () => {
    const { services, globals } = await isolated({ workspace: "./site" }, "/tmp/falryn-cwd");

    // The ordinary way to write the flag. Discarding it would take the project
    // layer out of every load while reporting success.
    const sources = runConfigPath(services, globals).payload?.sources ?? [];
    expect(sources.find((source) => source.kind === "project-file")?.path).toBe(
      `/tmp/falryn-cwd/site/${CONFIGURATION_FILE_NAME}`,
    );
  });

  test("resolves a --workspace that climbs out of the current directory", async () => {
    const { services, globals } = await isolated({ workspace: "../sibling" }, "/tmp/falryn-cwd");

    const sources = runConfigPath(services, globals).payload?.sources ?? [];
    expect(sources.find((source) => source.kind === "project-file")?.path).toBe(
      `/tmp/sibling/${CONFIGURATION_FILE_NAME}`,
    );
  });

  test("leaves an absolute --workspace alone", async () => {
    const { services, globals } = await isolated(
      { workspace: "/tmp/falryn-explicit" },
      "/tmp/other",
    );

    const sources = runConfigPath(services, globals).payload?.sources ?? [];
    expect(sources.find((source) => source.kind === "project-file")?.path).toBe(
      `/tmp/falryn-explicit/${CONFIGURATION_FILE_NAME}`,
    );
  });

  test("falls back to the current directory when no workspace was given", async () => {
    const { services, globals } = await isolated({}, "/tmp/falryn-cwd");

    const sources = runConfigPath(services, globals).payload?.sources ?? [];
    expect(sources.find((source) => source.kind === "project-file")?.path).toBe(
      `/tmp/falryn-cwd/${CONFIGURATION_FILE_NAME}`,
    );
  });
});

describe("config validate", () => {
  test("reports a clean configuration as valid", async () => {
    const { services, globals } = await isolated();
    const result = await runConfigValidate(services, {}, globals);

    expect(result.outcome).toEqual({ kind: "completed" });
    expect(result.payload).toEqual({ issues: [], valid: true });
  });

  test("reports the issues that make one invalid", async () => {
    const { services, globals } = await isolated();
    const result = await runConfigValidate(services, { "not.a.real.key": "1" }, globals);

    expect(result.payload?.valid).toBe(false);
    expect(result.payload?.issues.map((issue) => issue.kind)).toContain("unknown-key");
    expect(result.outcome.kind).toBe("failed");
  });
});

describe("config path", () => {
  test("names its sources without reading any of them", async () => {
    const { services, globals } = await isolated();
    const result = runConfigPath(services, globals);

    expect(result.outcome).toEqual({ kind: "completed" });
    const kinds = result.payload?.sources.map((source) => source.kind) ?? [];
    expect(kinds).toContain("user-file");
    expect(kinds).toContain("project-file");
    // Answering "where do settings come from" must not depend on the load
    // succeeding, because that is usually why the question is being asked.
    expect(result.errors).toEqual([]);
  });

  test("names the profile source only when one was selected", async () => {
    const without = await isolated();
    expect(
      runConfigPath(without.services, without.globals).payload?.sources.map((s) => s.kind),
    ).not.toContain("profile");

    const withProfile = await isolated({ profile: "work" });
    const sources = runConfigPath(withProfile.services, withProfile.globals).payload?.sources ?? [];
    expect(sources.some((source) => source.kind === "profile")).toBe(true);
    expect(sources.find((source) => source.kind === "profile")?.path).toContain("work.jsonc");
  });
});

describe("doctor", () => {
  test("reports every declared root and the classes with and without an owner", async () => {
    const { services } = await isolated();
    const result = await runDoctor(services);

    expect(result.outcome).toEqual({ kind: "completed" });
    expect(result.effect).toEqual({ intent: "none", observed: "none" });
    expect((result.payload?.roots.length ?? 0) > 0).toBe(true);
    expect(result.payload?.databasePath).toContain("falryn.sqlite");
    // Nothing has registered an owner on this path, so every class is
    // reported unregistered rather than assumed absent.
    expect((result.payload?.unregisteredClasses.length ?? 0) > 0).toBe(true);
  });

  test("reports an absent database as absent rather than creating one", async () => {
    const { services } = await isolated();
    const result = await runDoctor(services);

    // `reference/CLI.md` requires diagnostics not to mutate, and creating a
    // database to answer whether one exists is exactly that.
    expect(result.payload?.storage).toEqual({ kind: "absent" });
  });

  test("reports a database that exists, with the schema version it carries", async () => {
    const { services, home } = await isolated();
    const { main } = await import("../main.ts");
    await main({
      platform: "darwin",
      home: localPath(home),
      environment: createStaticEnvironment({ FALRYN_STATE_DIR: home }),
    });

    const result = await runDoctor(services);
    expect(result.payload?.storage).toMatchObject({ kind: "present", current: true });
  });
});
