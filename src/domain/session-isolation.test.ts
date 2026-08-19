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
} from "./session-isolation.ts";

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
