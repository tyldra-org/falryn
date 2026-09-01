import { describe, expect, test } from "bun:test";

import { formatKubernetesTableOutput } from "./table.ts";

describe("Hush Kubernetes table formatting", () => {
  test("keeps every native table row without an item cap", () => {
    const rows = Array.from(
      { length: 80 },
      (_, index) => `app-${index}    1/1     Running   ${index}          ${index + 1}m`,
    );
    const formatted = formatKubernetesTableOutput(
      ["NAME      READY   STATUS    RESTARTS   AGE", ...rows].join("\n"),
      ["kubectl", "get", "pods"],
    );
    expect(formatted).toContain("app-0");
    expect(formatted).toContain("app-79");
    expect(formatted).not.toContain("omitted");
    expect(formatted).not.toContain("…");
  });

  test("keeps every wide-table column while shortening presentation", () => {
    const formatted = formatKubernetesTableOutput(
      [
        "NAME         READY   STATUS    RESTARTS   AGE   IP          NODE",
        "falryn-api   1/1     Running   0          2m    10.42.0.8   worker-1",
      ].join("\n"),
      ["kubectl", "get", "pods", "-o", "wide"],
    );
    expect(formatted).toBe(
      "NAME\tREADY\tSTATUS\tRESTART\tAGE\tIP\tNODE\nfalryn-api\t1/1\tRunning\t0\t2m\t10.42.0.8\tworker-1",
    );
  });

  test("compacts OpenShift status without losing hierarchy or recovery commands", () => {
    const formatted = formatKubernetesTableOutput(
      [
        "In project falryn on server https://api.example:6443",
        "",
        "svc/falryn - 10.96.0.42:3000",
        "  deployment/falryn deploys image falryn:dev",
        "    deployment #2 running for 2 minutes - 1 pod",
        "",
        "View details with 'oc describe <resource>/<name>' or list everything with 'oc get all -o yaml'.",
      ].join("\n"),
      ["oc", "status"],
    );
    expect(formatted).toContain("project falryn @ https://api.example:6443");
    expect(formatted).toContain(">deployment/falryn deploys image falryn:dev");
    expect(formatted).toContain(">>deployment #2 running for 2 minutes - 1 pod");
    expect(formatted).toContain("'oc describe <resource>/<name>'");
    expect(formatted).toContain("'oc get all -o yaml'");
  });

  test("declines JSON, custom columns, no-header output, and watch streams", () => {
    const source = '{"kind":"Pod"}';
    expect(formatKubernetesTableOutput(source, ["kubectl", "get", "pod", "-o", "json"])).toBeNull();
    expect(
      formatKubernetesTableOutput(source, [
        "kubectl",
        "get",
        "pod",
        "--output=custom-columns=NAME:.metadata.name",
      ]),
    ).toBeNull();
    expect(formatKubernetesTableOutput("falryn", ["oc", "get", "pod", "--no-headers"])).toBeNull();
    expect(formatKubernetesTableOutput("event", ["kubectl", "get", "pod", "--watch"])).toBeNull();
  });
});
