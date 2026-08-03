import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REDACTED } from "../application/index.ts";
import {
  CONFIGURATION_FILE_NAME,
  CONFIGURATION_SCHEMA_VERSION,
  PROJECT_CONFIGURATION_DIRECTORY,
  SCHEMA_VERSION_FIELD,
} from "../config/index.ts";
import {
  createInMemoryFileSystem,
  createStaticEnvironment,
  err,
  type FileSystemErrorCode,
  type FileSystemPort,
  type InMemoryNode,
  localPath,
} from "../domain/index.ts";
import { runConfigPath, runConfigShow, runConfigValidate, runDoctor } from "./commands.ts";
import { EXIT_CODES, resolveExitCode } from "./exit.ts";
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

/**
 * A provider over the in-memory filesystem double.
 *
 * No temporary directory, and no dependence on what the running user is
 * permitted to do: every read outcome the matrix needs is stated rather than
 * arranged. The user file's path comes from the same layout the loader will
 * use, so nothing here re-derives where a source lives.
 */
function doubled(options: Partial<GlobalOptions> = {}) {
  const fileSystem = createInMemoryFileSystem();
  const globals = { ...DEFAULTS, ...options };
  const services = providerOver(fileSystem, globals);
  return {
    fileSystem,
    globals,
    services,
    workspaceFile: `/workspace/${PROJECT_CONFIGURATION_DIRECTORY}/${CONFIGURATION_FILE_NAME}`,
    userFile: `${services().configurationRoot}/${CONFIGURATION_FILE_NAME}`,
  };
}

/** A provider over a supplied filesystem, and a home no test shares. */
function providerOver(fileSystem: FileSystemPort, globals: GlobalOptions): ServiceProvider {
  return createServiceProvider(globals, {
    home: localPath("/home/tester"),
    platform: "darwin",
    environment: createStaticEnvironment({}),
    currentDirectory: localPath("/workspace"),
    fileSystem,
  });
}

/** One path's `readText` failing with a stated code, and everything else real. */
function refusingRead(
  base: FileSystemPort,
  path: string,
  code: FileSystemErrorCode,
): FileSystemPort {
  return {
    ...base,
    readText: async (target, maximumBytes, signal) =>
      target === path
        ? err({ kind: "filesystem", code, path: localPath(path), operation: "read-text" })
        : base.readText(target, maximumBytes, signal),
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
    expect(result.payload).toEqual({ issues: [], valid: true, unreadSources: [] });
  });

  test("reports the issues that make one invalid", async () => {
    const { services, globals } = await isolated();
    const result = await runConfigValidate(services, { "not.a.real.key": "1" }, globals);

    expect(result.payload?.valid).toBe(false);
    expect(result.payload?.issues.map((issue) => issue.kind)).toContain("unknown-key");
    expect(result.outcome.kind).toBe("failed");
  });
});

describe("config validate over a source it could not read", () => {
  // The double rather than a real disk: what a `chmod 000` file, a directory in
  // a file's place, and a mis-encoded document each produce is a property of
  // the `FileSystemPort` contract, and a matrix that depended on what the
  // running user happens to be permitted would be a test of the machine.
  const UNREAD: readonly { readonly state: string; readonly node: InMemoryNode }[] = [
    { state: "a directory where the file should be", node: { kind: "directory" } },
    { state: "a document past the byte bound", node: { kind: "file", byteLength: 300_000 } },
  ];
  for (const { state, node } of UNREAD) {
    test(`reports ${state} as unread, and exits 3`, async () => {
      const { fileSystem, services, globals, userFile } = doubled();
      fileSystem.put(userFile, node);

      const result = await runConfigValidate(services, {}, globals);

      // `valid` still answers only its own question: what loaded is usable.
      expect(result.payload?.valid).toBe(true);
      expect(result.payload?.unreadSources.map((report) => report.source.kind)).toEqual([
        "user-file",
      ]);
      expect(resolveExitCode({ outcome: result.outcome, error: result.errors[0] ?? null })).toBe(
        EXIT_CODES.CONFIGURATION,
      );
    });
  }

  test("tells an oversized document apart from one it could not open", async () => {
    const unreadable = doubled();
    unreadable.fileSystem.put(unreadable.userFile, { kind: "directory" });
    const oversized = doubled();
    oversized.fileSystem.put(oversized.userFile, { kind: "file", byteLength: 300_000 });

    const first = await runConfigValidate(unreadable.services, {}, unreadable.globals);
    const second = await runConfigValidate(oversized.services, {}, oversized.globals);

    // Two different repairs — a permission and a file size — so one word for
    // both would send half of the readers to the wrong place.
    expect(first.payload?.unreadSources[0]?.outcome).toBe("unreadable");
    expect(second.payload?.unreadSources[0]?.outcome).toBe("oversized");
    expect(first.errors[0]?.code).toBe("configuration.source-unreadable");
    expect(second.errors[0]?.code).toBe("configuration.source-oversized");
  });

  test("reports a document that is not valid UTF-8 as mis-encoded", async () => {
    const { fileSystem, globals, userFile } = doubled();
    // The double decodes whatever it is given, so the boundary failure is
    // supplied here. The host adapter's own mapping is covered by
    // `src/integrations/host-filesystem.test.ts`.
    const failing = refusingRead(fileSystem, userFile, "malformed-encoding");

    const result = await runConfigValidate(providerOver(failing, globals), {}, globals);

    expect(result.payload?.unreadSources[0]?.outcome).toBe("malformed-encoding");
    expect(result.errors[0]?.code).toBe("configuration.source-malformed-encoding");
  });

  test("says nothing about an absent or an empty source", async () => {
    const absent = doubled();
    const empty = doubled();
    empty.fileSystem.put(empty.userFile, { kind: "file", text: "  // only a comment\n" });

    for (const { services, globals } of [absent, empty]) {
      const result = await runConfigValidate(services, {}, globals);

      // A file that is not there says nothing, and `> falryn.jsonc` is a
      // deliberate act. Reporting either would train a reader to ignore the
      // finding that matters.
      expect(result.payload).toEqual({ issues: [], valid: true, unreadSources: [] });
      expect(result.outcome).toEqual({ kind: "completed" });
    }
  });

  test("names which source it was when another one loads normally", async () => {
    const { fileSystem, services, globals, userFile, workspaceFile } = doubled();
    fileSystem.put(userFile, { kind: "directory" });
    fileSystem.put(workspaceFile, {
      kind: "file",
      text: JSON.stringify({ [SCHEMA_VERSION_FIELD]: CONFIGURATION_SCHEMA_VERSION }),
    });

    const result = await runConfigValidate(services, {}, globals);

    expect(result.payload?.unreadSources.map((report) => report.source.kind)).toEqual([
      "user-file",
    ]);
    expect(String(result.payload?.unreadSources[0]?.source.file)).toBe(userFile);
  });

  test("carries no byte of the document it could not read", async () => {
    const { fileSystem, globals, userFile } = doubled();
    // Token-shaped content in a file that is then refused at the boundary: the
    // read produced these bytes for nobody, and no surface may show them.
    fileSystem.put(userFile, { kind: "file", text: `{"token": "${SECRET}"}` });
    const failing = refusingRead(fileSystem, userFile, "malformed-encoding");

    const result = await runConfigValidate(providerOver(failing, globals), {}, globals);

    expect(result.payload?.unreadSources.length).toBe(1);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test("reports it on a real disk too, for a file this user may not read", async () => {
    // One check against the actual boundary, so the matrix above is not the
    // only thing standing between a permission and a false verdict.
    if (process.getuid?.() === 0) {
      return;
    }
    const { services, globals } = await isolated();
    const root = services().configurationRoot;
    await mkdir(root, { recursive: true });
    const file = join(root, CONFIGURATION_FILE_NAME);
    await writeFile(file, "{}");
    await chmod(file, 0o000);

    const result = await runConfigValidate(services, {}, globals);

    expect(result.payload?.unreadSources[0]?.outcome).toBe("unreadable");
    expect(resolveExitCode({ outcome: result.outcome, error: result.errors[0] ?? null })).toBe(
      EXIT_CODES.CONFIGURATION,
    );
  });
});

describe("config show over a source it could not read", () => {
  test("still shows what loaded, and still exits zero", async () => {
    const { fileSystem, services, globals, userFile } = doubled();
    fileSystem.put(userFile, { kind: "directory" });

    const result = await runConfigShow(services, {}, globals);

    // The values it displayed did load, and displaying them is the command's
    // purpose. The finding is advisory here and blocking in `validate`.
    expect(result.outcome).toEqual({ kind: "completed" });
    expect(result.errors).toEqual([]);
    expect((result.payload?.inspection.values.length ?? 0) > 0).toBe(true);
    // Its payload already carried the report; #344 changed only who reads it.
    expect(
      result.payload?.inspection.sources.filter((report) => report.outcome === "unreadable").length,
    ).toBe(1);
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

  test("separates whether a root resolved from whether it can hold data", async () => {
    // The two questions the old `usable` field answered as one. A resolved
    // root whose path is a regular file resolved perfectly well.
    const { services } = await isolated();
    const result = await runDoctor(services);
    const state = result.payload?.roots.find((entry) => entry.root === "state");

    expect(state?.resolved).toBe(true);
    expect(state?.viability).toBe("ready");
    expect(Object.keys(state ?? {})).not.toContain("usable");
  });

  test("reports a state root that is a regular file as blocked, and exits non-zero", async () => {
    // The reported bug, end to end: this used to be indistinguishable from a
    // healthy machine that had not created a database yet.
    const home = await mkdtemp(join(tmpdir(), "falryn-viability-"));
    roots.push(home);
    const stateFile = join(home, "state-file");
    await writeFile(stateFile, "not a directory");

    const globals = { ...DEFAULTS };
    const services = createServiceProvider(globals, {
      home: localPath(home),
      platform: "darwin",
      environment: createStaticEnvironment({ FALRYN_STATE_DIR: stateFile }),
    });

    const result = await runDoctor(services);
    const state = result.payload?.roots.find((entry) => entry.root === "state");

    expect(state?.viability).toBe("blocked");
    expect(state?.code).toBe("not-a-directory");
    expect(result.payload?.blocked).toBe(true);
    // The diagnosis is the verdict, and the verdict is the exit status.
    expect(result.outcome).toEqual({ kind: "failed", effect: "none" });
    expect(resolveExitCode({ outcome: result.outcome, error: null })).toBe(
      EXIT_CODES.OPERATION_FAILED,
    );
    // It diagnosed; it changed nothing.
    expect(result.effect).toEqual({ intent: "none", observed: "none" });
  });

  test("does not claim a database is absent when its root cannot be reached", async () => {
    const home = await mkdtemp(join(tmpdir(), "falryn-viability-"));
    roots.push(home);
    const stateFile = join(home, "state-file");
    await writeFile(stateFile, "not a directory");

    const services = createServiceProvider(
      { ...DEFAULTS },
      {
        home: localPath(home),
        platform: "darwin",
        environment: createStaticEnvironment({ FALRYN_STATE_DIR: stateFile }),
      },
    );

    const result = await runDoctor(services);
    // `probeStorage` would map this to `absent`, which is the sentence that
    // made the original report say the machine was fine.
    expect(result.payload?.storage).toEqual({
      kind: "undetermined",
      reason: "state-root-not-viable",
    });
  });

  test("reports a root that does not exist as absent, and stays at exit zero", async () => {
    const home = await mkdtemp(join(tmpdir(), "falryn-viability-"));
    roots.push(home);

    const services = createServiceProvider(
      { ...DEFAULTS },
      {
        home: localPath(home),
        platform: "darwin",
        environment: createStaticEnvironment({ FALRYN_STATE_DIR: join(home, "not-created-yet") }),
      },
    );

    const result = await runDoctor(services);
    const state = result.payload?.roots.find((entry) => entry.root === "state");

    expect(state?.viability).toBe("absent");
    // An absent root is the normal first-run state, not a fault.
    expect(result.payload?.blocked).toBe(false);
    expect(result.outcome).toEqual({ kind: "completed" });
  });

  test("creates nothing, whatever it found", async () => {
    // The read-only control `doctor` never had. `help-does-no-work.test.ts`
    // covers help, version, and the bare invocation only.
    for (const state of ["state-file", "not-created-yet", "ready-directory"]) {
      const home = await mkdtemp(join(tmpdir(), "falryn-viability-"));
      roots.push(home);
      const target = join(home, state);
      if (state === "state-file") {
        await writeFile(target, "not a directory");
      }
      if (state === "ready-directory") {
        await mkdir(target, { recursive: true });
      }
      const before = (await readdir(home)).sort();

      const services = createServiceProvider(
        { ...DEFAULTS },
        {
          home: localPath(home),
          platform: "darwin",
          environment: createStaticEnvironment({ FALRYN_STATE_DIR: target }),
        },
      );
      await runDoctor(services);

      expect({ state, after: (await readdir(home)).sort() }).toEqual({ state, after: before });
      if (state === "ready-directory") {
        // And nothing inside the root it could reach, either.
        expect(await readdir(target)).toEqual([]);
      }
    }
  });
});
