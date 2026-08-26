import { describe, expect, test } from "bun:test";

import { hasCallerOwnedKubernetesOutput, parseKubernetesCommand } from "./kubernetes-command.ts";

describe("Kubernetes command parsing", () => {
  test("finds verbs after value-taking and boolean global options", () => {
    expect(
      parseKubernetesCommand(["kubectl", "--context", "prod", "-n", "app", "get", "pods"]),
    ).toEqual({
      executable: "kubectl",
      verb: "get",
      subcommand: null,
      verbIndex: 5,
    });
    expect(parseKubernetesCommand(["oc", "--warnings-as-errors", "adm", "top", "pods"])).toEqual({
      executable: "oc",
      verb: "adm",
      subcommand: "top",
      verbIndex: 2,
    });
  });

  test("distinguishes native wide tables from caller-owned projections", () => {
    expect(hasCallerOwnedKubernetesOutput(["kubectl", "get", "pods", "-o", "wide"])).toBe(false);
    expect(hasCallerOwnedKubernetesOutput(["kubectl", "get", "pods", "-o=json"])).toBe(true);
    expect(hasCallerOwnedKubernetesOutput(["oc", "get", "pods", "--no-headers"])).toBe(true);
    expect(
      hasCallerOwnedKubernetesOutput([
        "kubectl",
        "get",
        "pods",
        "--output=custom-columns=NAME:.metadata.name",
      ]),
    ).toBe(true);
  });

  test("does not claim other executables", () => {
    expect(parseKubernetesCommand(["docker", "ps"])).toBeNull();
  });
});
