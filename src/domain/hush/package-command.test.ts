import { describe, expect, test } from "bun:test";

import { hasPackageOutputOverride, packageAction, packageExecutable } from "./package-command.ts";

describe("Hush package command", () => {
  test("recognizes each requested manager and runner", () => {
    expect(
      ["npm", "pnpm", "yarn", "bun", "npx", "pnpx"].map((name) => packageExecutable([name])),
    ).toEqual(["npm", "pnpm", "yarn", "bun", "npx", "pnpx"]);
  });

  test("classifies manager actions without treating runner payloads as package actions", () => {
    expect(packageAction(["npm", "install"])).toBe("install");
    expect(packageAction(["npm", "uninstall", "legacy-package"])).toBe("install");
    expect(packageAction(["yarn", "upgrade"])).toBe("install");
    expect(packageAction(["pnpm", "--filter", "app", "list"])).toBe("list");
    expect(packageAction(["yarn", "outdated"])).toBe("outdated");
    expect(packageAction(["npm", "run", "custom"])).toBe("run");
    expect(packageAction(["bun", "install"])).toBe("install");
    expect(packageAction(["bun", "add", "zod"])).toBe("install");
    expect(packageAction(["bun", "run", "custom"])).toBe("run");
    expect(packageAction(["bun", "pm", "ls"])).toBe("list");
    expect(packageAction(["bun", "outdated"])).toBe("outdated");
    expect(packageAction(["bun", "audit"])).toBe("other");
    expect(packageAction(["yarn", "custom"])).toBe("run");
    expect(packageAction(["npx", "package-audit"])).toBe("other");
    expect(packageAction(["pnpx", "package-audit"])).toBe("other");
  });

  test("detects machine-readable and help output overrides", () => {
    expect(hasPackageOutputOverride(["npm", "list", "--json"])).toBe(true);
    expect(hasPackageOutputOverride(["pnpm", "list", "--reporter", "ndjson"])).toBe(true);
    expect(hasPackageOutputOverride(["yarn", "install", "--reporter=silent"])).toBe(true);
    expect(hasPackageOutputOverride(["bun", "outdated", "--json"])).toBe(true);
    expect(hasPackageOutputOverride(["bun", "run", "custom", "--silent"])).toBe(true);
    expect(hasPackageOutputOverride(["npm", "install"])).toBe(false);
  });
});
