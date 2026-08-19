import { describe, expect, test } from "bun:test";
import { backupName, MAX_BACKUP_NAME_LENGTH, userBackupFileName } from "./backup.ts";

describe("backupName", () => {
  test("accepts a printable name", () => {
    const parsed = backupName.parse("daily");
    expect(parsed.ok).toBe(true);
  });

  test("rejects an empty name", () => {
    expect(backupName.parse("")).toEqual({
      ok: false,
      error: { kind: "identity", code: "identifier-empty", identity: "backupName" },
    });
  });

  test("rejects a name past the declared length bound", () => {
    const parsed = backupName.parse("a".repeat(MAX_BACKUP_NAME_LENGTH + 1));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("identifier-too-long");
    }
  });

  test("never reports the rejected value", () => {
    const parsed = backupName.parse("../secret");
    expect(JSON.stringify(parsed)).not.toContain("secret");
  });

  test("names the copy so it cannot collide with a migration backup", () => {
    expect(userBackupFileName(backupName.from("daily"))).toBe("falryn-user-backup-daily.sqlite");
  });
});
