/**
 * Session catalog: list, name, pin, filter, and search without resume or rewind.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { sessionId } from "./identity.ts";
import {
  describeSessionCatalogError,
  editSessionCatalog,
  querySessionCatalog,
  SESSION_CATALOG_SOURCE,
  SESSION_CATALOG_VERSION,
} from "./session-catalog.ts";

function entry(
  id: string,
  overrides: {
    title?: string | null;
    pinned?: boolean;
    startedAt?: string;
    closedAt?: string | null;
  } = {},
) {
  return {
    sessionId: id,
    title: overrides.title === undefined ? id : overrides.title,
    pinned: overrides.pinned ?? false,
    startedAt: overrides.startedAt ?? "2026-07-31T12:00:00.000Z",
    closedAt: overrides.closedAt === undefined ? null : overrides.closedAt,
  };
}

describe("querySessionCatalog", () => {
  test("lists open sessions and omits closed ones when filtered", () => {
    const result = querySessionCatalog({
      sessions: [
        entry("open-session"),
        entry("closed-session", { closedAt: "2026-07-31T13:00:00.000Z" }),
      ],
      filter: "open",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.sessions.map((item) => item.sessionId)).toEqual([
      sessionId.from("open-session"),
    ]);
    expect(result.value.provenance).toEqual({
      version: SESSION_CATALOG_VERSION,
      source: SESSION_CATALOG_SOURCE,
      model: null,
    });
  });

  test("searches titles without inventing unnamed matches", () => {
    const result = querySessionCatalog({
      sessions: [entry("keep", { title: "Export restore" }), entry("skip", { title: null })],
      search: "export",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.sessions).toHaveLength(1);
    expect(result.value.sessions[0]?.sessionId).toBe(sessionId.from("keep"));
  });

  test("pins sort ahead of unpinned sessions", () => {
    const result = querySessionCatalog({
      sessions: [
        entry("later", { pinned: false, startedAt: "2026-07-31T14:00:00.000Z" }),
        entry("pinned", { pinned: true, startedAt: "2026-07-31T10:00:00.000Z" }),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.sessions.map((item) => item.sessionId)).toEqual([
      sessionId.from("pinned"),
      sessionId.from("later"),
    ]);
  });

  test("treats cancellation as cancelled, not as an empty catalog", () => {
    const result = querySessionCatalog({ sessions: [entry("open-session")] }, AbortSignal.abort());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("cancelled");
      expect(describeSessionCatalogError(result.error)).toBe("cancelled signal");
    }
  });

  test("never names a command runner, provider, git port, or mutation", async () => {
    const source = await readFile(new URL("./session-catalog.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(
      /CommandRunnerPort|ProviderPort|GitPort|FileSystemPort|Bun\.spawn|child_process|fetch\(|git add|git commit/,
    );
  });
});

describe("editSessionCatalog", () => {
  test("renames a declared session without inventing a new identity", () => {
    const result = editSessionCatalog({
      sessions: [entry("open-session", { title: "Old" })],
      edit: { kind: "rename", sessionId: "open-session", title: "  Named export  " },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.sessions[0]?.title).toBe("Named export");
    expect(result.value.sessions[0]?.sessionId).toBe(sessionId.from("open-session"));
  });

  test("pins a declared session so a pinned filter can see it", () => {
    const pinned = editSessionCatalog({
      sessions: [entry("open-session")],
      edit: { kind: "pin", sessionId: "open-session", pinned: true },
    });
    expect(pinned.ok).toBe(true);
    if (!pinned.ok) {
      return;
    }
    const filtered = querySessionCatalog({
      sessions: pinned.value.sessions,
      filter: "pinned",
    });
    expect(filtered.ok).toBe(true);
    if (filtered.ok) {
      expect(filtered.value.sessions).toHaveLength(1);
    }
  });

  test("refuses a rename that names a session outside the catalog", () => {
    const result = editSessionCatalog({
      sessions: [entry("open-session")],
      edit: { kind: "rename", sessionId: "missing-session", title: "Nope" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("not-found");
    }
  });
});
