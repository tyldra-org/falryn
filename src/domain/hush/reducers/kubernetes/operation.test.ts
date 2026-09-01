import { describe, expect, test } from "bun:test";

import { formatKubernetesOperationOutput } from "./operation.ts";

describe("Hush Kubernetes operation formatting", () => {
  test("keeps every apply resource and terminal action", () => {
    expect(
      formatKubernetesOperationOutput(
        [
          "deployment.apps/falryn configured",
          "service/falryn configured",
          "configmap/falryn created",
        ].join("\n"),
        ["kubectl", "apply", "-f", "app.yaml"],
      ),
    ).toBe("configured deployment.apps/falryn,service/falryn; created configmap/falryn");
  });

  test("compacts describe indentation and fields without dropping terminal facts", () => {
    const formatted = formatKubernetesOperationOutput(
      [
        "Name:             falryn-api",
        "Labels:           app=falryn",
        "                  component=api",
        "                  tier=control-plane",
        "Containers:",
        "  falryn:",
        "    Container ID:  containerd://sha256:736abc784def",
        "    Ready:         True",
        "Events:",
        "  Type    Reason     Age   From               Message",
        "  Normal  Scheduled  2m    scheduler          Successfully assigned falryn/falryn-api",
      ].join("\n"),
      ["kubectl", "describe", "pod", "falryn-api"],
    );
    expect(formatted).toContain("Name=falryn-api");
    expect(formatted).toContain("Labels=app=falryn\n>component=api\n>tier=control-plane");
    expect(formatted).toContain(">>Container ID=containerd://sha256:736abc784def");
    expect(formatted).toContain("Successfully assigned falryn/falryn-api");
  });

  test("formats OpenShift adm top as a complete uncapped table", () => {
    const rows = Array.from(
      { length: 80 },
      (_, index) => `app-${index}    ${index + 1}m          ${index + 32}Mi`,
    );
    const formatted = formatKubernetesOperationOutput(
      ["NAME      CPU(cores)   MEMORY(bytes)", ...rows].join("\n"),
      ["oc", "adm", "top", "pods"],
    );
    expect(formatted).toContain("app-0");
    expect(formatted).toContain("app-79");
    expect(formatted).not.toContain("omitted");
  });

  test("declines unknown operations, warnings, and incomplete outcomes", () => {
    expect(
      formatKubernetesOperationOutput("yes", ["kubectl", "auth", "can-i", "get", "pods"]),
    ).toBeNull();
    expect(
      formatKubernetesOperationOutput(
        "warning: changed policy\ndeployment.apps/falryn configured",
        ["kubectl", "apply", "-f", "app.yaml"],
      ),
    ).toBeNull();
    expect(
      formatKubernetesOperationOutput("deployment.apps/falryn", [
        "kubectl",
        "apply",
        "-f",
        "app.yaml",
      ]),
    ).toBeNull();
  });
});
