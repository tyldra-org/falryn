/**
 * Session isolation: bound workspace only, stale root/Git warned.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { sessionId, workspaceId } from "./identity.ts";
import {
  inspectSessionIsolation,
  SESSION_ISOLATION_SOURCE,
  SESSION_ISOLATION_VERSION,
  workspaceBindingFromSet,
} from "./session-isolation.ts";
import { createWorkspaceSet } from "./workspace-set.ts";

const bound = {
  workspaceId: "workspace-bound",
  root: "/repo",
  gitIdentity: "github.com/tyldra-org/falryn",
};

describe("inspectSessionIsolation", () => {
  test("omits sessions from another workspace", () => {
    const result = inspectSessionIsolation({
      bound,
      sessions: [
        { sessionId: "keep", workspaceId: bound.workspaceId },
        { sessionId: "foreign", workspaceId: "workspace-other" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.sessions.map((item) => item.sessionId)).toEqual([sessionId.from("keep")]);
    expect(result.value.omitted).toBe(1);
    expect(result.value.warnings).toEqual([]);
    expect(result.value.provenance).toEqual({
      version: SESSION_ISOLATION_VERSION,
      source: SESSION_ISOLATION_SOURCE,
      model: null,
    });
  });

  test("warns when the bound root has gone stale", () => {
    const result = inspectSessionIsolation({
      bound,
      observed: { ...bound, root: "/other" },
      sessions: [{ sessionId: "keep", workspaceId: bound.workspaceId }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.warnings).toEqual(["stale-root"]);
      expect(result.value.workspaceId).toBe(workspaceId.from(bound.workspaceId));
    }
  });

  test("warns when the bound Git identity has gone stale", () => {
    const result = inspectSessionIsolation({
      bound,
      observed: { ...bound, gitIdentity: "github.com/other/repo" },
      sessions: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.warnings).toEqual(["stale-git"]);
    }
  });

  test("warns when a bound multi-root set has gone stale", () => {
    const withRoots = {
      ...bound,
      roots: [
        { rootId: "root-a", path: "/repo" },
        { rootId: "root-b", path: "/docs" },
      ],
    };
    const result = inspectSessionIsolation({
      bound: withRoots,
      observed: {
        ...withRoots,
        roots: [
          { rootId: "root-a", path: "/repo" },
          { rootId: "root-b", path: "/other-docs" },
        ],
      },
      sessions: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.warnings).toEqual(["stale-root"]);
    }
  });

  test("builds a session binding from a workspace set", () => {
    const set = createWorkspaceSet([
      { rootId: "root-a", name: "falryn", path: "/work/falryn" },
      { rootId: "root-b", name: "docs", path: "/work/docs" },
    ]);
    expect(set.ok).toBe(true);
    if (!set.ok) {
      throw new Error("expected set");
    }
    const binding = workspaceBindingFromSet(workspaceId.from("workspace-bound"), set.value, null);
    expect(binding.root).toBe("/work/falryn");
    expect(binding.roots).toEqual([
      { rootId: "root-a", path: "/work/falryn" },
      { rootId: "root-b", path: "/work/docs" },
    ]);
    const isolated = inspectSessionIsolation({ bound: binding, sessions: [] });
    expect(isolated.ok).toBe(true);
    if (isolated.ok) {
      expect(isolated.value.warnings).toEqual([]);
    }
  });

  test("refuses treating a different workspace id as the same binding", () => {
    const result = inspectSessionIsolation({
      bound,
      observed: { ...bound, workspaceId: "workspace-other" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("malformed");
    }
  });

  test("treats cancellation as cancelled, not as an empty workspace", () => {
    const result = inspectSessionIsolation({ bound }, AbortSignal.abort());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("cancelled");
    }
  });

  test("never names a command runner, provider, git port, or mutation", async () => {
    const source = await readFile(new URL("./session-isolation.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(
      /CommandRunnerPort|ProviderPort|GitPort|FileSystemPort|Bun\.spawn|child_process|fetch\(|git add|git commit/,
    );
  });
});
