import { afterEach, expect, test } from "bun:test";
import { openProductStoreOrThrow, removeTemporaryRoots, temporaryRoot } from "../fixtures.ts";
import { createWorkspaceProfilePreferences } from "./profile-preferences.ts";

afterEach(removeTemporaryRoots);
test("personal preferences survive restart, isolate workspaces and compare revisions", async () => {
  const root = await temporaryRoot("falryn-workspace-profile-");
  const first = await openProductStoreOrThrow(root);
  const owner = createWorkspaceProfilePreferences(first);
  const signal = new AbortController().signal;
  expect(owner.write("workspace-a", "b", 0, signal).ok).toBe(true);
  expect(owner.write("workspace-a", "c", 0, signal)).toMatchObject({
    error: { code: "workspace-preference-conflict" },
  });
  expect(owner.read("workspace-b")).toEqual({ ok: true, value: { profile: null, revision: 0 } });
  await first.close();
  const second = await openProductStoreOrThrow(root);
  const restored = createWorkspaceProfilePreferences(second);
  expect(restored.read("workspace-a")).toEqual({ ok: true, value: { profile: "b", revision: 1 } });
  expect(restored.write("workspace-a", null, 1, AbortSignal.abort()).ok).toBe(false);
  expect(restored.write("workspace-a", null, 1, signal).ok).toBe(true);
  expect(restored.read("workspace-a")).toEqual({ ok: true, value: { profile: null, revision: 2 } });
  await second.close();
});
