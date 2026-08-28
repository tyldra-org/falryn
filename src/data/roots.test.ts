import { describe, expect, test } from "bun:test";

import {
  blocksLocalData,
  createInMemoryFileSystem,
  createStaticEnvironment,
  type InMemoryNode,
  LOCAL_DATA_ROOTS,
  type LocalDataPlatform,
  localPath,
  type RootInspection,
} from "../domain/index.ts";
import {
  inspectRoots,
  PRIVATE_DIRECTORY_MODE,
  prepareRoots,
  QUALIFIED_PLATFORM,
  ROOT_ENVIRONMENT_VARIABLES,
  resolveRoots,
  rootChild,
  usableRoots,
} from "./roots.ts";

const HOME = localPath("/Users/example");

function resolve(platform: LocalDataPlatform, environment: Readonly<Record<string, string>> = {}) {
  return resolveRoots({
    platform,
    home: HOME,
    environment: createStaticEnvironment(environment),
  });
}

function pathFor(platform: LocalDataPlatform, root: string): string {
  const found = resolve(platform).layout.roots.find((candidate) => candidate.root === root);
  return String(found?.path);
}

describe("the platform layout", () => {
  test("resolves every declared root on every declared platform", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const { layout } = resolve(platform);
      expect(layout.roots.map((resolved) => resolved.root)).toEqual([...LOCAL_DATA_ROOTS]);
      for (const resolved of layout.roots) {
        expect(resolved.path.startsWith("/") || /^[A-Za-z]:\//.test(resolved.path)).toBe(true);
      }
    }
  });

  test("marks only the qualified platform as qualified", () => {
    expect(QUALIFIED_PLATFORM).toBe("darwin");
    expect(resolve("darwin").layout.qualified).toBe(true);
    expect(resolve("linux").layout.qualified).toBe(false);
    expect(resolve("win32").layout.qualified).toBe(false);
  });

  test("keeps durable data and rebuildable caches in separate roots", () => {
    // They must never share deletion semantics, and the cheapest way to
    // guarantee that is for them never to share a directory.
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const paths = new Set(resolve(platform).layout.roots.map((resolved) => resolved.path));
      expect(paths.size).toBe(LOCAL_DATA_ROOTS.length);
      expect(pathFor(platform, "state")).not.toBe(pathFor(platform, "cache"));
    }
  });

  test("uses macOS conventions on the qualified target", () => {
    const { layout } = resolve("darwin");
    expect(pathFor("darwin", "configuration")).toBe("/Users/example/.falryn");
    expect(String(layout.legacyConfigurationRoot)).toBe(
      "/Users/example/Library/Application Support/Falryn/config",
    );
    expect(pathFor("darwin", "cache")).toBe("/Users/example/Library/Caches/Falryn");
    expect(pathFor("darwin", "logs")).toBe("/Users/example/Library/Logs/Falryn");
  });

  test("uses the visible configuration home and keeps XDG for state on Linux", () => {
    const { layout } = resolve("linux", { XDG_CONFIG_HOME: "/xdg/config" });
    const configuration = layout.roots.find((resolved) => resolved.root === "configuration");
    expect(String(configuration?.path)).toBe("/Users/example/.falryn");
    expect(configuration?.provenance).toBe("platform-default");
    expect(String(layout.legacyConfigurationRoot)).toBe("/xdg/config/falryn");
    expect(pathFor("linux", "state")).toBe("/Users/example/.local/state/falryn");
  });

  test("uses APPDATA and LOCALAPPDATA on Windows", () => {
    const { layout } = resolve("win32", { LOCALAPPDATA: "C:/Users/example/AppData/Local" });
    expect(pathFor("win32", "configuration")).toBe("/Users/example/.falryn");
    const cache = layout.roots.find((resolved) => resolved.root === "cache");
    expect(String(cache?.path)).toBe("C:/Users/example/AppData/Local/Falryn/cache");
  });
});

describe("environment overrides", () => {
  test("every root declares the variable that overrides it", () => {
    const { layout } = resolve("darwin");
    for (const resolved of layout.roots) {
      expect(resolved.environmentVariable).toBe(ROOT_ENVIRONMENT_VARIABLES[resolved.root]);
      expect(resolved.environmentVariable).toMatch(/^FALRYN_[A-Z_]+$/);
    }
  });

  test("an override replaces the platform default and says so", () => {
    const { layout } = resolve("darwin", { FALRYN_CACHE_DIR: "/tmp/falryn-cache" });
    const cache = layout.roots.find((resolved) => resolved.root === "cache");
    expect(String(cache?.path)).toBe("/tmp/falryn-cache");
    expect(cache?.provenance).toBe("environment-override");
  });

  test("the configuration root is overridable only from the environment", () => {
    // Configuration discovery has to find its root before it can read a key, so
    // the variable is the only way to move it.
    const { layout } = resolve("darwin", { FALRYN_CONFIG_DIR: "/tmp/falryn-config" });
    const configuration = layout.roots.find((resolved) => resolved.root === "configuration");
    expect(String(configuration?.path)).toBe("/tmp/falryn-config");
    expect(ROOT_ENVIRONMENT_VARIABLES.configuration).toBe("FALRYN_CONFIG_DIR");
    expect(layout.legacyConfigurationRoot).toBeNull();
  });

  test("a configured but invalid configuration override still disables legacy lookup", () => {
    const resolution = resolve("darwin", { FALRYN_CONFIG_DIR: "relative/config" });
    const configuration = resolution.layout.roots.find(
      (resolved) => resolved.root === "configuration",
    );

    expect(configuration?.provenance).toBe("platform-default");
    expect(resolution.layout.legacyConfigurationRoot).toBeNull();
    expect(resolution.issues).toContainEqual({
      root: "configuration",
      source: "environment-override",
      variable: "FALRYN_CONFIG_DIR",
      code: "path-not-absolute",
    });
  });

  test("an empty configuration override remains unset and keeps legacy lookup", () => {
    const { layout } = resolve("darwin", { FALRYN_CONFIG_DIR: "" });

    expect(layout.legacyConfigurationRoot).not.toBeNull();
  });

  test("an unusable override is reported and falls back, never silently ignored", () => {
    const resolution = resolve("darwin", { FALRYN_LOG_DIR: "relative/logs" });
    const logs = resolution.layout.roots.find((resolved) => resolved.root === "logs");
    expect(logs?.provenance).toBe("platform-default");
    expect(resolution.issues).toEqual([
      {
        root: "logs",
        source: "environment-override",
        variable: "FALRYN_LOG_DIR",
        code: "path-not-absolute",
      },
    ]);
  });

  test("an exported-but-empty variable reads as unset", () => {
    const { layout } = resolve("darwin", { FALRYN_CACHE_DIR: "" });
    const cache = layout.roots.find((resolved) => resolved.root === "cache");
    expect(cache?.provenance).toBe("platform-default");
  });

  test("an override is normalized rather than trusted verbatim", () => {
    const { layout } = resolve("darwin", { FALRYN_STATE_DIR: "/tmp//falryn/./state/" });
    const state = layout.roots.find((resolved) => resolved.root === "state");
    expect(String(state?.path)).toBe("/tmp/falryn/state");
  });
});

describe("preparing roots", () => {
  test("a first run creates the smallest requested set, privately", async () => {
    const fileSystem = createInMemoryFileSystem({ nodes: { "/tmp": { kind: "directory" } } });
    const { layout } = resolve("darwin", {
      FALRYN_LOG_DIR: "/tmp/logs",
      FALRYN_CACHE_DIR: "/tmp/cache",
    });

    const statuses = await prepareRoots(fileSystem, layout, ["logs"]);

    expect(statuses).toEqual([
      {
        root: "logs",
        path: localPath("/tmp/logs"),
        code: "created",
        expectedMode: PRIVATE_DIRECTORY_MODE,
        observedMode: null,
      },
    ]);
    // Only what was asked for: an unused root would be an empty directory that
    // uninstall then has to explain.
    expect(fileSystem.paths()).not.toContain(localPath("/tmp/cache"));
  });

  test("an existing complete layout is left alone and reported as existing", async () => {
    const fileSystem = createInMemoryFileSystem({
      nodes: { "/tmp/logs": { kind: "directory", mode: 0o700 } },
    });
    const { layout } = resolve("darwin", { FALRYN_LOG_DIR: "/tmp/logs" });

    const statuses = await prepareRoots(fileSystem, layout, ["logs"]);

    expect(statuses[0]?.code).toBe("existed");
    expect(statuses[0]?.observedMode).toBe(0o700);
  });

  test("a root that is a file is a diagnostic, not a replacement", async () => {
    const fileSystem = createInMemoryFileSystem({
      nodes: { "/tmp/logs": { kind: "file", byteLength: 10 } },
    });
    const { layout } = resolve("darwin", { FALRYN_LOG_DIR: "/tmp/logs" });

    const statuses = await prepareRoots(fileSystem, layout, ["logs"]);

    expect(statuses[0]?.code).toBe("not-a-directory");
    // The file is still there. Something else is using that path, and deleting
    // it to make room would destroy the evidence.
    expect(fileSystem.paths()).toContain(localPath("/tmp/logs"));
  });

  test("an unwritable root is reported rather than repaired", async () => {
    const fileSystem = createInMemoryFileSystem({
      nodes: { "/tmp/logs": { kind: "directory", mode: 0o500, writable: false } },
    });
    const { layout } = resolve("darwin", { FALRYN_LOG_DIR: "/tmp/logs" });

    const statuses = await prepareRoots(fileSystem, layout, ["logs"]);
    expect(statuses[0]?.code).toBe("not-writable");
  });

  test("group- or world-readable permissions are reported, never widened or narrowed", async () => {
    const fileSystem = createInMemoryFileSystem({
      nodes: { "/tmp/logs": { kind: "directory", mode: 0o755 } },
    });
    const { layout } = resolve("darwin", { FALRYN_LOG_DIR: "/tmp/logs" });

    const statuses = await prepareRoots(fileSystem, layout, ["logs"]);

    expect(statuses[0]).toMatchObject({
      code: "insecure-permissions",
      expectedMode: PRIVATE_DIRECTORY_MODE,
      observedMode: 0o755,
    });
  });

  test("a root that cannot be created is unavailable, and the rest continue", async () => {
    const fileSystem = createInMemoryFileSystem({
      nodes: { "/tmp": { kind: "directory", writable: false } },
    });
    const { layout } = resolve("darwin", {
      FALRYN_LOG_DIR: "/tmp/logs",
      FALRYN_STATE_DIR: "/elsewhere/state",
    });

    const statuses = await prepareRoots(fileSystem, layout, ["logs", "state"]);

    expect(statuses.find((status) => status.root === "logs")?.code).toBe("unavailable");
    expect(statuses.find((status) => status.root === "state")?.code).toBe("created");
    expect(usableRoots(statuses)).toEqual(["state"]);
  });

  test("preparation is idempotent", async () => {
    const fileSystem = createInMemoryFileSystem({ nodes: { "/tmp": { kind: "directory" } } });
    const { layout } = resolve("darwin", { FALRYN_LOG_DIR: "/tmp/logs" });

    const first = await prepareRoots(fileSystem, layout, ["logs"]);
    const second = await prepareRoots(fileSystem, layout, ["logs"]);

    expect(first[0]?.code).toBe("created");
    expect(second[0]?.code).toBe("existed");
  });

  test("cancellation stops preparation without creating anything", async () => {
    const fileSystem = createInMemoryFileSystem({ nodes: { "/tmp": { kind: "directory" } } });
    const { layout } = resolve("darwin", { FALRYN_LOG_DIR: "/tmp/logs" });
    const controller = new AbortController();
    controller.abort();

    const statuses = await prepareRoots(fileSystem, layout, ["logs"], controller.signal);

    expect(statuses[0]?.code).toBe("unavailable");
    expect(fileSystem.paths()).not.toContain(localPath("/tmp/logs"));
  });
});

describe("inspecting roots", () => {
  /** One root under `/tmp/logs`, so each case names exactly one path. */
  async function inspectLogs(nodes: Readonly<Record<string, InMemoryNode>>) {
    const fileSystem = createInMemoryFileSystem({ nodes });
    const { layout } = resolve("darwin", { FALRYN_LOG_DIR: "/tmp/logs" });
    const inspections = await inspectRoots(fileSystem, layout);
    const logs = inspections.find((entry) => entry.root === "logs");
    return { fileSystem, logs };
  }

  test("reports a directory this process may write into as ready", async () => {
    const { logs } = await inspectLogs({ "/tmp/logs": { kind: "directory", mode: 0o700 } });
    expect(logs?.viability).toBe("ready");
    expect(logs?.code).toBeNull();
    expect(logs?.observedMode).toBe(0o700);
  });

  test("creates nothing, which is the whole reason it exists", async () => {
    // `prepareRoots` would create this path. A diagnostic that had to create a
    // directory to find out whether it could is not a diagnostic.
    const { fileSystem } = await inspectLogs({ "/tmp": { kind: "directory" } });
    expect(fileSystem.paths()).toEqual([localPath("/tmp")]);
  });

  test("reports a missing root as absent when something could create it", async () => {
    const { logs } = await inspectLogs({ "/tmp": { kind: "directory" } });
    // Not a fault. The first run that needs it will create it, and reporting a
    // fresh machine as broken trains a reader to ignore real findings.
    expect(logs?.viability).toBe("absent");
    expect(logs?.code).toBeNull();
  });

  test("keeps absent and ready distinguishable", async () => {
    const absent = await inspectLogs({ "/tmp": { kind: "directory" } });
    const ready = await inspectLogs({ "/tmp/logs": { kind: "directory", mode: 0o700 } });
    expect(absent.logs?.viability).not.toBe(ready.logs?.viability);
  });

  test("reports a regular file as blocked, not as an empty root", async () => {
    // The reported bug: this used to render as a healthy root with no database
    // created yet.
    const { logs } = await inspectLogs({ "/tmp/logs": { kind: "file", byteLength: 10 } });
    expect(logs?.viability).toBe("blocked");
    expect(logs?.code).toBe("not-a-directory");
  });

  test("reports a directory it cannot write into as blocked", async () => {
    const { logs } = await inspectLogs({
      "/tmp/logs": { kind: "directory", mode: 0o500, writable: false },
    });
    expect(logs?.viability).toBe("blocked");
    expect(logs?.code).toBe("not-writable");
  });

  test("reports a missing root under an unwritable parent as blocked", async () => {
    // Absent would promise a first run that can never happen.
    const { logs } = await inspectLogs({
      "/tmp": { kind: "directory", writable: false },
    });
    expect(logs?.viability).toBe("blocked");
    expect(logs?.code).toBe("parent-not-writable");
  });

  test("reports a missing root under a parent that is a file as blocked", async () => {
    const { logs } = await inspectLogs({ "/tmp": { kind: "file", byteLength: 1 } });
    expect(logs?.viability).toBe("blocked");
    expect(logs?.code).toBe("parent-not-writable");
  });

  test("walks up to the nearest existing ancestor", async () => {
    const fileSystem = createInMemoryFileSystem({ nodes: { "/tmp": { kind: "directory" } } });
    const { layout } = resolve("darwin", { FALRYN_LOG_DIR: "/tmp/a/b/c/logs" });
    const inspections = await inspectRoots(fileSystem, layout);
    // `/tmp` is writable and every level between is missing, so the root is
    // absent rather than blocked.
    expect(inspections.find((entry) => entry.root === "logs")?.viability).toBe("absent");
  });

  test("judges a symlink by its target rather than by the link", async () => {
    // `stat` does not follow a final symlink, so without resolution a symlink
    // to a perfectly good directory reads as `not-a-directory`.
    const { logs } = await inspectLogs({
      "/tmp/logs": { kind: "symlink", target: "/tmp/real" },
      "/tmp/real": { kind: "directory", mode: 0o700 },
    });
    expect(logs?.viability).toBe("ready");
  });

  test("reports a symlink with no target as blocked", async () => {
    const { logs } = await inspectLogs({
      "/tmp/logs": { kind: "symlink", target: "/tmp/missing" },
    });
    expect(logs?.viability).toBe("blocked");
    expect(logs?.code).toBe("dangling-symlink");
  });

  test("reports a symlink to a file as blocked for the right reason", async () => {
    const { logs } = await inspectLogs({
      "/tmp/logs": { kind: "symlink", target: "/tmp/real" },
      "/tmp/real": { kind: "file", byteLength: 4 },
    });
    expect(logs?.viability).toBe("blocked");
    expect(logs?.code).toBe("not-a-directory");
  });

  test("reports wide permissions on a root that otherwise works", async () => {
    // Advisory, not blocking: the directory holds data, and should not be
    // readable by everyone while it does.
    const { logs } = await inspectLogs({ "/tmp/logs": { kind: "directory", mode: 0o755 } });
    expect(logs?.viability).toBe("ready");
    expect(logs?.code).toBe("insecure-permissions");
  });

  test("reports a probe that did not complete as unknown, never as ready", async () => {
    const fileSystem = createInMemoryFileSystem({
      nodes: { "/tmp/logs": { kind: "directory", mode: 0o700 } },
    });
    const { layout } = resolve("darwin", { FALRYN_LOG_DIR: "/tmp/logs" });
    const controller = new AbortController();
    controller.abort();

    const inspections = await inspectRoots(fileSystem, layout, controller.signal);
    for (const inspection of inspections) {
      expect(inspection.viability).toBe("unknown");
      expect(inspection.code).toBe("cancelled");
    }
  });

  test("answers for every declared root", async () => {
    const fileSystem = createInMemoryFileSystem({ nodes: { "/tmp": { kind: "directory" } } });
    const { layout } = resolve("darwin");
    const inspections = await inspectRoots(fileSystem, layout);
    expect(inspections.map((entry) => entry.root)).toEqual([...LOCAL_DATA_ROOTS]);
  });

  test("says a blocked and an unknown root prevent use, and absent does not", async () => {
    const blocked = await inspectLogs({ "/tmp/logs": { kind: "file", byteLength: 1 } });
    const absent = await inspectLogs({ "/tmp": { kind: "directory" } });
    const ready = await inspectLogs({ "/tmp/logs": { kind: "directory", mode: 0o700 } });

    expect(blocksLocalData(blocked.logs as RootInspection)).toBe(true);
    expect(blocksLocalData(absent.logs as RootInspection)).toBe(false);
    expect(blocksLocalData(ready.logs as RootInspection)).toBe(false);
  });
});

describe("naming a child of a root", () => {
  test("resolves a child inside its root", () => {
    const { layout } = resolve("darwin", { FALRYN_LOG_DIR: "/tmp/logs" });
    expect(rootChild(layout, "logs", "session.log")).toBe(localPath("/tmp/logs/session.log"));
  });

  test("refuses a segment that would climb out", () => {
    const { layout } = resolve("darwin", { FALRYN_LOG_DIR: "/tmp/logs" });
    expect(rootChild(layout, "logs", "..")).toBeNull();
    expect(rootChild(layout, "logs", "../../etc")).toBeNull();
    expect(rootChild(layout, "logs", "nested/deep")).toBeNull();
  });
});
