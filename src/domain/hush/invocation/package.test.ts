import { describe, expect, test } from "bun:test";

import { hasPackageOutputOverride, packageAction, packageExecutable } from "./package.ts";

describe("Hush package command", () => {
  test("recognizes each requested manager and runner", () => {
    const executables = [
      "npm",
      "pnpm",
      "yarn",
      "bun",
      "npx",
      "pnpx",
      "pip",
      "pip3",
      "uv",
      "poetry",
      "brew",
      "composer",
      "bundle",
    ] as const;
    expect(executables.map((name) => packageExecutable([name]))).toEqual([...executables]);
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
    expect(packageAction(["pip", "install", "requests"])).toBe("install");
    expect(packageAction(["pip3", "list", "--outdated"])).toBe("outdated");
    expect(packageAction(["pip", "show", "requests"])).toBe("show");
    expect(packageAction(["uv", "sync"])).toBe("install");
    expect(packageAction(["uv", "run", "pytest"])).toBe("other");
    expect(packageAction(["poetry", "install"])).toBe("install");
    expect(packageAction(["poetry", "show"])).toBe("list");
    expect(packageAction(["poetry", "list"])).toBe("other");
    expect(packageAction(["brew", "reinstall", "jq"])).toBe("install");
    expect(packageAction(["brew", "list"])).toBe("list");
    expect(packageAction(["composer", "require", "psr/log"])).toBe("install");
    expect(packageAction(["composer", "show"])).toBe("list");
    expect(packageAction(["composer", "list"])).toBe("other");
    expect(packageAction(["bundle", "list"])).toBe("list");
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
    expect(hasPackageOutputOverride(["pip", "list", "--format", "json"])).toBe(true);
    expect(hasPackageOutputOverride(["uv", "sync", "--quiet"])).toBe(true);
    expect(hasPackageOutputOverride(["bundle", "install", "-q"])).toBe(true);
    expect(hasPackageOutputOverride(["npm", "install"])).toBe(false);
  });
});
